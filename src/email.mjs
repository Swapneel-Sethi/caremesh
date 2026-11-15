import crypto from 'node:crypto';
import { config } from './config.mjs';
import { persistOutbox } from './store.mjs';

export async function sendReminder({ to, subject, text }) {
  if (!config.resendApiKey) {
    await persistOutbox({ id: crypto.randomUUID(), to, subject, text, status: 'preview', sentAt: new Date().toISOString() });
    return { delivered: false, mode: 'preview' };
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.mailFrom, to: [to], subject, text })
  });
  if (!response.ok) throw new Error(`Email provider failed: ${response.status}`);
  return { delivered: true, mode: 'resend' };
}
