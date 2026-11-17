import crypto from 'node:crypto';
import { config } from './config.mjs';
import { persistOutbox } from './store.mjs';

function providerCode(value) {
  return /^[a-z0-9_]{1,60}$/i.test(String(value || '')) ? String(value) : 'provider_error';
}

async function providerStatus(providerId) {
  try {
    const response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(providerId)}`, {
      headers: { Authorization: `Bearer ${config.resendApiKey}` }
    });
    if (!response.ok) return 'accepted';
    const body = await response.json();
    return providerCode(body.last_event);
  } catch {
    return 'accepted';
  }
}

export async function sendReminder({ to, subject, text, kind = 'reminder', key = null, user = null }) {
  const recipients = (Array.isArray(to) ? to : [to]).map((item) => String(item || '').trim()).filter(Boolean);
  const record = {
    id: crypto.randomUUID(),
    kind,
    key,
    subject,
    status: 'preview',
    recipientCount: recipients.length,
    sentAt: new Date().toISOString()
  };
  // Keep the outbox scoped to the care recipient when the caller knows it.
  const save = () => (user ? persistOutbox(user, record) : persistOutbox(record));

  if (!config.resendApiKey) {
    await save();
    return { delivered: false, mode: 'preview', status: 'preview' };
  }

  if (!recipients.length) {
    record.status = 'unconfigured';
    await save();
    return { delivered: false, mode: 'unconfigured', status: 'unconfigured' };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.mailFrom, to: recipients, subject, text })
    });

    if (!response.ok) {
      let name = 'provider_error';
      try {
        const errorBody = await response.json();
        name = providerCode(errorBody?.name);
      } catch {}
      record.status = 'failed';
      record.providerStatus = String(response.status);
      record.error = name;
      await save();
      return { delivered: false, mode: 'resend', status: 'failed', providerStatus: response.status, error: name };
    }

    const body = await response.json().catch(() => ({}));
    record.status = 'sent';
    record.providerStatus = body.id ? await providerStatus(body.id) : 'accepted';
    await save();
    return { delivered: true, mode: 'resend', status: 'sent', providerStatus: record.providerStatus };
  } catch {
    record.status = 'failed';
    record.error = 'network_error';
    await save();
    return { delivered: false, mode: 'resend', status: 'failed', error: 'network_error' };
  }
}
