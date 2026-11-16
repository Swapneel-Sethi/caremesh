import { config } from './config.mjs';
import { domainSnapshot, persistEvent, persistReminder, checkReminderExists } from './store.mjs';
import { sendReminder } from './email.mjs';
import { clockLabel, dateLong, dayOffset, localParts, scheduleLabel, timeToMinutes } from './time.mjs';

function getUserSnapshot(snapshot, user) {
  return { ...snapshot, _user: user };
}

const UPCOMING_MEDICATION_MINUTES = 60;
const MEDICATION_DUE_NOW_MINUTES = 15;
const MEDICATION_GRACE_MINUTES = 30;
const APPOINTMENT_WINDOW_MINUTES = 24 * 60;

function appLink(section) {
  return `${config.appOrigin.replace(/\/$/, '')}/#${section}`;
}

function careRecipient(profile) {
  if (!profile) return 'the care circle';
  return profile.age ? `${profile.name}, ${profile.age}` : profile.name;
}

function medicationMessage(profile, medication, kind) {
  const missed = kind === 'medication-missed';
  const scheduled = scheduleLabel(medication.schedule);
  const subject = missed
    ? `CareMesh alert · Missed medication: ${medication.name}`
    : `CareMesh · Medication due soon: ${medication.name}`;
  const heading = missed ? 'MISSED MEDICATION' : 'MEDICATION DUE SOON';
  const status = missed ? 'Overdue and not recorded' : 'Not taken yet';
  const action = missed
    ? 'Check with the elder, then record the dose or mark it missed so the care circle can follow up.'
    : 'Confirm the dose in CareMesh after it is taken, or mark it missed if it was not taken.';
  const text = [
    'CareMesh · CarePulse reminder',
    '',
    `Care circle for ${careRecipient(profile)}.`,
    '',
    heading,
    medication.name,
    `Scheduled: today at ${scheduled}`,
    `Status: ${status}`,
    `Instructions: ${medication.instructions}`,
    '',
    `Action: ${action}`,
    '',
    `Open CareMesh: ${appLink('medications')}`,
    '',
    'This automated message was sent by CareMesh CarePulse.'
  ].join('\n');
  return { subject, text };
}

function appointmentMessage(profile, appointment) {
  const when = `${dateLong(appointment.date)} at ${scheduleLabel(appointment.time)}`;
  const subject = `CareMesh · Appointment reminder: ${appointment.doctor} on ${dateLong(appointment.date)}`;
  const text = [
    'CareMesh · CarePulse appointment reminder',
    '',
    `Care circle for ${careRecipient(profile)}.`,
    '',
    'UPCOMING APPOINTMENT',
    `${appointment.doctor} · ${appointment.specialty}`,
    when,
    `Location: ${appointment.location}`,
    `Status: ${appointment.status === 'confirmed' ? 'Confirmed' : 'Scheduled'}`,
    appointment.notes ? `Notes: ${appointment.notes}` : null,
    '',
    'Action: Confirm transport and bring the current medication list.',
    '',
    `Open CareMesh: ${appLink('appointments')}`,
    '',
    'This automated message was sent by CareMesh CarePulse.'
  ].filter((line) => line !== null).join('\n');
  return { subject, text };
}

export function buildReminderCandidates(snapshot, now = new Date(), timeZone = config.reminderTimeZone) {
  const local = localParts(now, timeZone);
  const dateKey = local.date;
  const profile = snapshot.profiles?.[0];
  const candidates = [];

  for (const medication of snapshot.medications || []) {
    if (medication.status !== 'pending') continue;
    const difference = timeToMinutes(medication.schedule) - local.minutes;
    let kind = null;
    if (difference <= UPCOMING_MEDICATION_MINUTES && difference >= -MEDICATION_DUE_NOW_MINUTES) kind = 'medication-upcoming';
    else if (difference <= -MEDICATION_GRACE_MINUTES) kind = 'medication-missed';
    if (!kind) continue;
    const message = medicationMessage(profile, medication, kind);
    candidates.push({
      key: `${kind}:${dateKey}:${medication.id}`,
      kind,
      summary: {
        key: `${kind}:${dateKey}:${medication.id}`,
        kind,
        medicationId: medication.id,
        medicationName: medication.name,
        scheduledTime: medication.schedule
      },
      detail: `${medication.name} · ${scheduleLabel(medication.schedule)}`,
      ...message
    });
  }

  for (const appointment of snapshot.appointments || []) {
    if (['cancelled', 'completed'].includes(String(appointment.status || '').toLowerCase())) continue;
    const appointmentDate = String(appointment.date || '');
    const appointmentTime = String(appointment.time || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate) || !/^\d{2}:\d{2}$/.test(appointmentTime)) continue;
    const difference = (dayOffset(dateKey, appointmentDate) * 1440) + timeToMinutes(appointmentTime) - local.minutes;
    if (difference < 0 || difference > APPOINTMENT_WINDOW_MINUTES) continue;
    const message = appointmentMessage(profile, appointment);
    candidates.push({
      key: `appointment:${appointmentDate}:${appointment.id}`,
      kind: 'appointment-upcoming',
      summary: {
        key: `appointment:${appointmentDate}:${appointment.id}`,
        kind: 'appointment-upcoming',
        appointmentId: appointment.id,
        doctor: appointment.doctor,
        date: appointmentDate,
        time: appointmentTime
      },
      detail: `${appointment.doctor} · ${dateLong(appointmentDate)} at ${scheduleLabel(appointmentTime)}`,
      ...message
    });
  }

  return candidates;
}

function eventTitle(kind, status) {
  if (status === 'failed') return 'Reminder delivery failed';
  if (status === 'unconfigured') return 'Reminder not sent · no care-circle email configured';
  if (status === 'preview') return 'Reminder prepared in preview mode';
  if (kind === 'medication-missed') return 'Missed medication alert sent';
  if (kind === 'medication-upcoming') return 'Medication reminder sent';
  return 'Appointment reminder sent';
}

export async function previewReminders({ now = new Date(), snapshot, user } = {}) {
  const state = snapshot || await domainSnapshot(user);
  return Promise.all(buildReminderCandidates(state, now).map(async (candidate) => {
    const duplicate = await checkReminderExists(user, candidate.key);
    return {
      ...candidate.summary,
      subject: candidate.subject,
      duplicate
    };
  }));
}

export async function runReminders({ actor = 'CarePulse', now = new Date(), snapshot, user } = {}) {
  const state = snapshot || await domainSnapshot(user);
  const results = [];

  for (const candidate of buildReminderCandidates(state, now)) {
    const duplicate = await checkReminderExists(user, candidate.key);
    if (duplicate) {
      results.push({ ...candidate.summary, status: 'duplicate', delivered: false });
      continue;
    }

    const delivery = await sendReminder({
      to: config.careTeamAlertEmails,
      subject: candidate.subject,
      text: candidate.text,
      kind: candidate.kind,
      key: candidate.key
    });

    if (delivery.status === 'sent' || delivery.status === 'preview') {
      await persistReminder(user, { key: candidate.key, kind: candidate.kind, status: delivery.status, at: now.toISOString() });
    }

    await persistEvent(user, {
      at: clockLabel(now, config.reminderTimeZone),
      title: eventTitle(candidate.kind, delivery.status),
      actor,
      type: 'reminder',
      detail: candidate.detail
    });

    results.push({ ...candidate.summary, ...delivery });
  }

  return { results, checkedAt: now.toISOString(), timeZone: config.reminderTimeZone };
}
