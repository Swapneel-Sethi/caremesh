import { config } from './config.mjs';

let cachedToken = null;
let cachedExpiry = 0;

async function getGoogleAccessToken() {
  if (cachedToken && cachedExpiry > Date.now() + 60_000) return cachedToken;
  const response = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'Metadata-Flavor': 'Google' }
  });
  if (!response.ok) throw new Error(`Google metadata token request failed: ${response.status}`);
  const body = await response.json();
  cachedToken = body.access_token;
  cachedExpiry = Date.now() + Number(body.expires_in || 300) * 1000;
  return cachedToken;
}

export async function generateCareBrief(snapshot) {
  if (!config.googleProject) return deterministicCareBrief(snapshot);
  const token = await getGoogleAccessToken();
  const url = `https://${config.googleLocation}-aiplatform.googleapis.com/v1/projects/${config.googleProject}/locations/${config.googleLocation}/publishers/google/models/${config.geminiModel}:generateContent`;
  const prompt = `You are CarePulse, an elder care coordination assistant. Summarize only the structured information provided. Do not diagnose, prescribe, or invent medical facts. Identify today's care tasks, missed/pending items, upcoming appointment needs, and one practical coordination action. Use short labels and plain language for an older adult and their caregiver. Data: ${JSON.stringify(snapshot)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 280 }
    })
  });
  if (!response.ok) throw new Error(`Vertex AI request failed: ${response.status}`);
  const body = await response.json();
  return body?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n')?.trim() || deterministicCareBrief(snapshot);
}

function timeLabel(value) {
  const [hours, minutes] = String(value).split(':').map(Number);
  const suffix = hours >= 12 ? 'pm' : 'am';
  const hour = hours % 12 || 12;
  return `${hour}:${String(minutes || 0).padStart(2, '0')} ${suffix}`;
}

function deterministicCareBrief(snapshot) {
  const pending = snapshot.medications.filter((med) => med.status === 'pending');
  const missed = snapshot.medications.filter((med) => med.status === 'missed');
  const nextAppointment = [...snapshot.appointments]
    .filter((appointment) => new Date(`${appointment.date}T${appointment.time}`) >= new Date())
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))[0];
  const lines = [
    `TODAY\n${snapshot.medications.length - pending.length} of ${snapshot.medications.length} scheduled medications confirmed.`,
    pending.length ? `PENDING\n${pending.map((med) => `${med.name} at ${timeLabel(med.schedule)}`).join('; ')}` : 'PENDING\nNo pending medication confirmations.',
    missed.length ? `ATTENTION\n${missed.length} medication item${missed.length === 1 ? '' : 's'} marked missed.` : 'ATTENTION\nNo missed medication events recorded.',
    nextAppointment ? `NEXT\n${nextAppointment.doctor} · ${nextAppointment.specialty} · ${timeLabel(nextAppointment.time)}` : 'NEXT\nNo upcoming appointments found.',
    'ACTION\nCheck the evening routine and keep the designated caregiver informed of any missed dose.'
  ];
  return lines.join('\n\n');
}
