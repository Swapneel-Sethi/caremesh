// Care Brief provider adapter.
//
// Adaption stays off for Care Brief by default: the CodeDia contribution is the
// CarePulse escalation decision layer. When explicitly enabled it receives only
// schedules, statuses and roles, never names, contact details or notes.

import { config } from './config.mjs';
import { generateCareBrief as generateGeminiCareBrief } from './google.mjs';
import { createAdaptionResponse } from './adaption.mjs';

const BRIEF_INSTRUCTIONS = `You are CarePulse, an elder care coordination assistant.
Summarize only the structured information provided. Do not diagnose, prescribe, or invent medical facts.
Identify confirmed and pending items, missed items, upcoming appointment needs, and one practical coordination action.
Use short labels and plain language.`;

function timeLabel(value) {
  const [hours, minutes] = String(value || '').split(':').map(Number);
  if (!Number.isFinite(hours)) return 'scheduled';
  const suffix = hours >= 12 ? 'pm' : 'am';
  return `${hours % 12 || 12}:${String(minutes || 0).padStart(2, '0')} ${suffix}`;
}

function safeBriefData(snapshot = {}) {
  const medications = Array.isArray(snapshot.medications) ? snapshot.medications : [];
  const appointments = Array.isArray(snapshot.appointments) ? snapshot.appointments : [];
  const careTeam = Array.isArray(snapshot.careTeam) ? snapshot.careTeam : [];
  return {
    medications: medications.slice(0, 20).map((medication) => ({
      schedule: String(medication.schedule || '').slice(0, 5),
      status: String(medication.status || '').slice(0, 20),
      category: String(medication.category || '').slice(0, 40)
    })),
    appointments: appointments.slice(0, 10).map((appointment) => ({
      date: String(appointment.date || '').slice(0, 10),
      time: String(appointment.time || '').slice(0, 5),
      status: String(appointment.status || '').slice(0, 20)
    })),
    careTeamRoles: careTeam.slice(0, 10).map((member) => String(member.role || '').slice(0, 20))
  };
}

function responseText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();
  const output = Array.isArray(response?.output) ? response.output : [];
  return output
    .filter((item) => item?.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .map((part) => part?.text || '')
    .join('\n')
    .trim();
}

async function adaptionCareBrief(snapshot, options = {}) {
  const response = await createAdaptionResponse({
    model: options.model || config.adaptionModel,
    instructions: BRIEF_INSTRUCTIONS,
    input: JSON.stringify({ care_snapshot: safeBriefData(snapshot) }),
    maxOutputTokens: options.maxOutputTokens || 320,
    temperature: 0.2,
    store: false,
    enabled: options.enabled,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl
  });
  return responseText(response);
}

function deterministicBrief(snapshot = {}) {
  const medications = Array.isArray(snapshot.medications) ? snapshot.medications : [];
  const appointments = Array.isArray(snapshot.appointments) ? snapshot.appointments : [];
  const pending = medications.filter((medication) => medication.status === 'pending');
  const missed = medications.filter((medication) => medication.status === 'missed');
  const next = appointments
    .filter((appointment) => !['cancelled', 'completed'].includes(String(appointment.status || '').toLowerCase()))
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))[0];

  return [
    `TODAY\n${medications.length - pending.length} of ${medications.length} scheduled medications confirmed.`,
    pending.length
      ? `PENDING\n${pending.slice(0, 5).map((medication) => `${medication.name} at ${timeLabel(medication.schedule)}`).join('; ')}`
      : 'PENDING\nNo pending medication confirmations.',
    missed.length
      ? `ATTENTION\n${missed.length} medication item${missed.length === 1 ? '' : 's'} marked missed.`
      : 'ATTENTION\nNo missed medication events recorded.',
    next ? `NEXT\n${next.doctor} · ${next.specialty} · ${timeLabel(next.time)}` : 'NEXT\nNo upcoming appointments found.',
    'ACTION\nCheck the evening routine and keep the designated caregiver informed of any missed dose.'
  ].join('\n\n');
}

export async function generateCareBrief(snapshot, options = {}) {
  const useAdaption = options.provider === 'adaption' ||
    (options.provider !== 'gemini' && config.adaptionEnabled && config.adaptionCareBriefEnabled);

  if (useAdaption) {
    try {
      const brief = await adaptionCareBrief(snapshot, options);
      if (brief) return brief;
    } catch {
      // Fall through to the existing Gemini provider.
    }
  }

  try {
    return await generateGeminiCareBrief(snapshot);
  } catch {
    return deterministicBrief(snapshot);
  }
}
