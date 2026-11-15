const main = document.querySelector('#main');
const nav = document.querySelector('#section-nav');
const logoutButton = document.querySelector('#logout-btn');
const sessionUser = document.querySelector('#session-user');
const toastRegion = document.querySelector('#toast-region');

let selectedRole = 'elder';
let dashboard = null;
let activeView = 'overview';

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const roleLabels = { elder: 'Elder', caregiver: 'Caregiver', family: 'Family' };
const roleCopy = {
  elder: { title: 'Elder', description: 'I manage my own care' },
  caregiver: { title: 'Caregiver', description: 'I help with daily care' },
  family: { title: 'Family', description: 'I stay informed' }
};
const views = [
  ['overview', 'Overview'],
  ['medications', 'Medications'],
  ['appointments', 'Appointments'],
  ['care-team', 'Care Circle'],
  ['timeline', 'Timeline']
];
const viewTitles = { overview: 'Overview', medications: 'Medications', appointments: 'Appointments', 'care-team': 'Care Circle', timeline: 'Timeline' };

function viewFromHash() {
  const id = location.hash.replace('#', '');
  return viewTitles[id] ? id : 'overview';
}

activeView = viewFromHash();

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function friendlyError(message) {
  const messages = {
    'Invalid access code': 'That access code does not match this role. Please check the code and try again.',
    'Authentication required': 'Please sign in again to continue.',
    'schedule must be HH:MM': 'Please choose a valid time.',
    'time must be HH:MM': 'Please choose a valid time.',
    'date is invalid': 'Please choose a valid date.',
    'name is invalid': 'Please check the medication name.',
    'doctor is invalid': "Please enter the doctor's name.",
    'Payload too large': 'That request was too large. Please try again.'
  };
  return messages[message] || message;
}

function formatTime(time) {
  return new Date(`2000-01-01T${time}:00`).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
}

function formatDateLong(date) {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
}

function formatDateShort(date) {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

function appointmentDay(date) {
  const target = new Date(`${date}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((target - today) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return formatDateLong(date);
}

function todayLong() {
  return new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
}

function dueDate(time) {
  const [hours, minutes] = String(time).split(':').map(Number);
  const date = new Date();
  date.setHours(hours || 0, minutes || 0, 0, 0);
  return date;
}

function initialsOf(name) {
  return String(name).split(' ').filter(Boolean).map((word) => word[0]).join('').slice(0, 2).toUpperCase();
}

function medicationState(medication) {
  if (medication.status === 'taken') return { label: 'Taken', tone: 'ok', glyph: '✓' };
  if (medication.status === 'missed') return { label: 'Missed', tone: 'danger', glyph: '!' };
  if (dueDate(medication.schedule) < new Date()) return { label: 'Overdue', tone: 'warn', glyph: '!' };
  return { label: 'Due later', tone: 'neutral', glyph: '○' };
}

function chipClass(tone) {
  return { ok: 'chip-ok', warn: 'chip-warn', danger: 'chip-danger', neutral: 'chip-neutral' }[tone] || 'chip-neutral';
}

function medicationDetail(list) {
  return list.map((medication) => `${medication.name} at ${formatTime(medication.schedule)}`).join(' and ');
}

function carePulse(medications) {
  const pending = medications.filter((medication) => medication.status === 'pending');
  const missed = medications.filter((medication) => medication.status === 'missed');
  const overdue = pending.filter((medication) => dueDate(medication.schedule) < new Date());

  if (missed.length) {
    return {
      tone: 'danger',
      label: 'Missed',
      message: `${medicationDetail(missed)} ${missed.length === 1 ? 'was' : 'were'} not confirmed at the scheduled time. Mark ${missed.length === 1 ? 'it' : 'them'} as taken if the dose was taken, or ask the caregiver to review the plan.`
    };
  }
  if (overdue.length) {
    return {
      tone: 'warn',
      label: 'Needs attention',
      message: `${medicationDetail(overdue)} ${overdue.length === 1 ? 'is' : 'are'} overdue. Mark ${overdue.length === 1 ? 'it' : 'them'} as taken, or ask the caregiver to check in.`
    };
  }
  if (pending.length) {
    return {
      tone: 'neutral',
      label: 'Upcoming',
      message: `${medicationDetail(pending)} ${pending.length === 1 ? 'is' : 'are'} due later today. Nothing needs your attention right now.`
    };
  }
  if (!medications.length) {
    return { tone: 'ok', label: 'On track', message: 'No medications are scheduled for today.' };
  }
  return { tone: 'ok', label: 'On track', message: 'All medications are confirmed for today. Nothing needs your attention right now.' };
}

function sortedAppointments() {
  return [...dashboard.appointments].sort((a, b) => new Date(`${a.date}T${a.time}`) - new Date(`${b.date}T${b.time}`));
}

function nextAppointment() {
  return sortedAppointments().find((appointment) => new Date(`${appointment.date}T${appointment.time}`) >= new Date()) || null;
}

function pageHead(title, lead) {
  return `<section class="page-head"><h1>${title}</h1><p class="lead">${lead}</p></section>`;
}

function navMarkup() {
  return views.map(([id, label]) => `<button type="button" class="nav-link" data-view="${id}"${id === activeView ? ' aria-current="page"' : ''}>${label}</button>`).join('');
}

function renderDashboard(view = 'overview') {
  activeView = view;
  const user = dashboard.user;
  document.title = `CareMesh — ${viewTitles[view]}`;
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  sessionUser.textContent = `${user.name} · ${roleLabels[user.role] || user.role}`;
  sessionUser.classList.remove('hidden');
  nav.innerHTML = navMarkup();
  nav.classList.remove('hidden');
  logoutButton.classList.remove('hidden');
  main.innerHTML = viewMarkup(view);
  main.setAttribute('aria-busy', 'false');
  bindInteractions();
}

function viewMarkup(view) {
  if (view === 'medications') return medicationsView();
  if (view === 'appointments') return appointmentsView();
  if (view === 'care-team') return careTeamView();
  if (view === 'timeline') return timelineView();
  return overviewView();
}

function overviewView() {
  const medications = dashboard.medications;
  const taken = medications.filter((medication) => medication.status === 'taken').length;
  const firstName = dashboard.profile.name.split(' ')[0];
  const pulse = carePulse(medications);
  const isElder = dashboard.user.role === 'elder';
  return `
    ${pageHead(isElder ? `Hello, ${escapeHtml(firstName)}.` : `${escapeHtml(firstName)}’s care today.`, `Today is ${escapeHtml(todayLong())}. ${isElder ? 'Here is what needs your attention, in order.' : 'Here is what needs attention, in order.'}`)}
    <div class="stack">
      ${focusCard(medications, dashboard.user.role !== 'family')}
      ${medicationSummaryCard(medications, taken)}
      <div class="cols">
        ${appointmentCard(nextAppointment())}
        ${pulseCard(pulse)}
      </div>
      ${careCircleCard()}
      ${careBriefCard()}
    </div>`;
}

function focusCard(medications, editable) {
  const pending = medications.filter((medication) => medication.status === 'pending');
  const next = pending[0] || medications.find((medication) => medication.status === 'missed');
  if (!next) {
    return `<section class="card card-feature" aria-labelledby="focus-title">
      <p class="eyebrow">Next step</p>
      <h2 id="focus-title">Everything is on track for today.</h2>
      <p class="lead">${medications.length ? 'All medications are confirmed. Nothing needs your attention right now.' : 'No medications are scheduled today.'}</p>
      <div class="button-row"><button class="button button-secondary" data-view="medications">View medications</button></div>
    </section>`;
  }
  const state = medicationState(next);
  const needsAttention = state.tone === 'warn' || state.tone === 'danger';
  return `<section class="card card-feature" aria-labelledby="focus-title">
    <p class="eyebrow">${needsAttention ? 'Needs attention' : 'Next medication'}</p>
    <h2 id="focus-title">${escapeHtml(next.name)}</h2>
    <p class="focus-meta">Due ${escapeHtml(formatTime(next.schedule))} today · ${escapeHtml(next.instructions)}</p>
    <div class="chip-row"><span class="chip ${chipClass(state.tone)}"><span aria-hidden="true">${state.glyph}</span> ${escapeHtml(state.label)}</span></div>
    ${pending.length > 1 ? `<p class="helper">${pending.length - 1} more medication${pending.length - 1 === 1 ? '' : 's'} still to confirm today.</p>` : ''}
    <div class="button-row">
      ${editable ? `<button class="button button-primary button-large" data-take="${next.id}">✓ Mark as taken</button>` : ''}
      <button class="button button-secondary" data-view="medications">View all medications</button>
    </div>
    ${editable ? '' : '<p class="helper">Family access is read-only. The elder and caregiver confirm doses.</p>'}
  </section>`;
}

function medicationSummaryCard(medications, taken) {
  const countLabel = medications.length ? `${taken} of ${medications.length} taken` : 'None scheduled';
  const percent = medications.length ? Math.round((taken / medications.length) * 100) : 100;
  return `<section class="card" aria-labelledby="medications-title">
    <div class="card-head">
      <h2 id="medications-title">Today’s medications</h2>
      <span class="chip chip-neutral">${countLabel}</span>
    </div>
    ${medications.length ? `<div class="progress" role="progressbar" aria-label="Medications taken today" aria-valuemin="0" aria-valuemax="${medications.length}" aria-valuenow="${taken}"><span class="progress-fill" style="width:${percent}%"></span></div>` : ''}
    <ul class="med-list">${medications.map((medication) => medicationRow(medication, false)).join('')}</ul>
  </section>`;
}

function medicationRow(medication, editable) {
  const state = medicationState(medication);
  const canAct = editable && medication.status !== 'taken';
  return `<li class="med-item">
    <div>
      <h3>${escapeHtml(medication.name)}</h3>
      <p class="row-meta"><strong>${escapeHtml(formatTime(medication.schedule))} · Today</strong> · ${escapeHtml(medication.frequency)}</p>
      <p class="row-note">${escapeHtml(medication.instructions)}</p>
    </div>
    <div class="row-side">
      <span class="chip ${chipClass(state.tone)}"><span aria-hidden="true">${state.glyph}</span> ${escapeHtml(state.label)}</span>
      ${canAct ? `<button class="button button-primary" data-take="${medication.id}">✓ Mark as taken</button>` : ''}
    </div>
  </li>`;
}

function pulseCard(pulse) {
  return `<section class="card" aria-labelledby="pulse-title">
    <div class="card-head"><h2 id="pulse-title">CarePulse</h2><span class="chip ${chipClass(pulse.tone)}">${escapeHtml(pulse.label)}</span></div>
    <p class="lead">${escapeHtml(pulse.message)}</p>
  </section>`;
}

function appointmentCard(appointment, showLink = true) {
  if (!appointment) {
    return `<section class="card" aria-labelledby="next-appt-title">
      <div class="card-head"><h2 id="next-appt-title">Next appointment</h2></div>
      <p class="lead">No upcoming appointments are scheduled.</p>
    </section>`;
  }
  return `<section class="card" aria-labelledby="next-appt-title">
    <div class="card-head"><h2 id="next-appt-title">Next appointment</h2><span class="chip ${appointment.status === 'confirmed' ? 'chip-ok' : 'chip-neutral'}">${escapeHtml(appointmentStatus(appointment))}</span></div>
    <h3>${escapeHtml(appointment.doctor)}</h3>
    <p class="appt-when">${escapeHtml(appointmentDay(appointment.date))} · ${escapeHtml(formatTime(appointment.time))}</p>
    <p class="row-meta">${escapeHtml(appointment.specialty)} · ${escapeHtml(appointment.location)}</p>
    ${showLink ? `<div class="button-row"><button class="button button-secondary" data-view="appointments">View appointments</button></div>` : ''}
  </section>`;
}

function appointmentStatus(appointment) {
  if (appointment.status === 'confirmed') return 'Confirmed';
  if (appointment.status === 'upcoming') return 'Scheduled';
  return appointment.status.charAt(0).toUpperCase() + appointment.status.slice(1);
}

function careCircleCard() {
  return `<section class="card" aria-labelledby="circle-title">
    <div class="card-head"><h2 id="circle-title">Care circle</h2><span class="chip chip-neutral">${dashboard.careTeam.length + 1} people</span></div>
    <ul>${carePeople().map(personRow).join('')}</ul>
    <div class="button-row"><button class="button button-secondary" data-view="care-team">View care circle</button></div>
  </section>`;
}

function carePeople() {
  const accessCopy = {
    'medications + appointments': 'Helps with medications and appointments',
    'medications + appointments + alerts': 'Helps with medications, appointments and alerts',
    'view + alerts': 'Can view care details and receive alerts'
  };
  return [
    { name: dashboard.profile.name, role: 'Elder', access: 'Full control of care details and access', initials: initialsOf(dashboard.profile.name) },
    ...dashboard.careTeam.map((member) => ({ ...member, access: accessCopy[member.access] || member.access, initials: member.avatar || initialsOf(member.name) }))
  ];
}

function personRow(person) {
  return `<li class="person">
    <span class="avatar" aria-hidden="true">${escapeHtml(person.initials)}</span>
    <div class="person-main"><h3>${escapeHtml(person.name)}</h3><p>${escapeHtml(person.access)}</p></div>
    <span class="chip ${person.role === 'Elder' ? 'chip-ok' : 'chip-neutral'}">${escapeHtml(person.role)}</span>
  </li>`;
}

function careBriefCard() {
  return `<section class="card" aria-labelledby="brief-title">
    <div class="card-head"><h2 id="brief-title">Today’s care brief</h2><span class="chip chip-neutral">Summary</span></div>
    <p class="brief">${escapeHtml(dashboard.careBrief)}</p>
  </section>`;
}

function medicationsView() {
  const editable = dashboard.user.role !== 'family';
  const medications = dashboard.medications;
  const taken = medications.filter((medication) => medication.status === 'taken').length;
  const percent = medications.length ? Math.round((taken / medications.length) * 100) : 100;
  const pulse = carePulse(medications);
  const lead = editable
    ? 'Confirm each medicine after you take it. Times and instructions are shown for every dose.'
    : 'Here are the medications in this care plan. Family access is read-only.';
  return `
    ${pageHead('Medications', lead)}
    <div class="stack">
      ${pulseCard(pulse)}
      <section class="card" aria-labelledby="all-meds-title">
        <div class="card-head">
          <h2 id="all-meds-title">All medications</h2>
          <span class="chip chip-neutral">${medications.length ? `${taken} of ${medications.length} taken` : 'None scheduled'}</span>
        </div>
        ${medications.length ? `<div class="progress" role="progressbar" aria-label="Medications taken today" aria-valuemin="0" aria-valuemax="${medications.length}" aria-valuenow="${taken}"><span class="progress-fill" style="width:${percent}%"></span></div>` : ''}
        <ul class="med-list">${medications.map((medication) => medicationRow(medication, editable)).join('')}</ul>
        ${editable ? `<div class="button-row">
          <button class="button button-secondary" id="add-med-btn">Add medication</button>
          <button class="button button-secondary" id="run-reminders-btn">Send reminders</button>
        </div><p class="helper">Send reminders checks due medications and upcoming appointments, then emails your care circle.</p>` : `<p class="read-only">Family access is read-only. The elder and caregiver manage medications.</p>`}
      </section>
    </div>`;
}

function appointmentsView() {
  const editable = dashboard.user.role !== 'family';
  const appointments = sortedAppointments();
  const next = nextAppointment();
  return `
    ${pageHead('Appointments', 'Your next visit is shown first, with the date, time and place.')}
    <div class="stack">
      ${appointmentCard(next, false)}
      <section class="card" aria-labelledby="all-appts-title">
        <div class="card-head"><h2 id="all-appts-title">All appointments</h2><span class="chip chip-neutral">${appointments.length} scheduled</span></div>
        <ul class="appt-list">${appointments.map((appointment) => appointmentRow(appointment)).join('')}</ul>
        ${editable ? `<div class="button-row"><button class="button button-primary" id="add-appt-btn">Add appointment</button></div>` : `<p class="read-only">Family access is read-only for appointment changes.</p>`}
      </section>
    </div>`;
}

function appointmentRow(appointment) {
  return `<li class="appt-item">
    <div>
      <h3>${escapeHtml(appointment.doctor)}</h3>
      <p class="row-meta">${escapeHtml(appointment.specialty)}</p>
      <p class="row-meta"><strong>${escapeHtml(formatDateShort(appointment.date))} · ${escapeHtml(formatTime(appointment.time))}</strong> · ${escapeHtml(appointment.location)}</p>
      ${appointment.notes ? `<p class="row-note">${escapeHtml(appointment.notes)}</p>` : ''}
    </div>
    <div class="appt-side"><span class="chip ${appointment.status === 'confirmed' ? 'chip-ok' : 'chip-neutral'}">${escapeHtml(appointmentStatus(appointment))}</span></div>
  </li>`;
}

function careTeamView() {
  return `
    ${pageHead('Care circle', 'The people you trust to help with your care, and what each person can do.')}
    <div class="stack">
      <section class="card" aria-labelledby="people-title">
        <div class="card-head"><h2 id="people-title">People in your circle</h2><span class="chip chip-neutral">${dashboard.careTeam.length + 1} people</span></div>
        <ul>${carePeople().map(personRow).join('')}</ul>
      </section>
      <section class="card">
        <h2>You stay in control</h2>
        <p class="lead">Only the elder decides who can see or change care details. Every change is checked securely, and family access is read-only.</p>
        <div class="button-row"><button class="button button-secondary" data-view="timeline">View recent activity</button></div>
      </section>
    </div>`;
}

function timelineView() {
  return `
    ${pageHead('Timeline', 'A simple record of medication, appointment and access activity.')}
    <section class="card" aria-labelledby="timeline-title">
      <div class="card-head"><h2 id="timeline-title">Recent activity</h2><span class="chip chip-neutral">${dashboard.events.length} events</span></div>
      <ol class="timeline">${dashboard.events.map((event) => `<li class="timeline-item">
        <span class="timeline-time">${escapeHtml(event.at)}</span>
        <div><h3>${escapeHtml(event.title)}</h3><p>${escapeHtml(event.actor)} · ${escapeHtml(event.detail)}</p></div>
      </li>`).join('')}</ol>
    </section>`;
}

function bindInteractions() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => renderDashboard(button.dataset.view)));

  document.querySelectorAll('[data-take]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      await api(`/api/medications/${button.dataset.take}`, { method: 'PATCH', body: JSON.stringify({ status: 'taken' }) });
      await loadDashboard();
      toast('Marked as taken.');
    } catch (error) {
      button.disabled = false;
      button.textContent = '✓ Mark as taken';
      toast(friendlyError(error.message), true);
    }
  }));

  document.querySelector('#add-med-btn')?.addEventListener('click', () => modal('Add medication', `
    <form id="med-form" class="form-grid">
      <div class="field full"><label for="med-name">Medication name and dose</label><input id="med-name" name="name" class="input" required placeholder="e.g. Vitamin D3 1000 IU" /></div>
      <div class="field"><label for="med-time">Time to take</label><input id="med-time" name="schedule" type="time" class="input" required /></div>
      <div class="field"><label for="med-frequency">How often</label><input id="med-frequency" name="frequency" class="input" value="Daily" /></div>
      <div class="field full"><label for="med-instructions">Instructions</label><input id="med-instructions" name="instructions" class="input" value="Take after food." /></div>
      <p class="form-error full" role="alert" tabindex="-1" hidden></p>
      <div class="full button-row"><button class="button button-primary" type="submit">Save medication</button></div>
    </form>`));

  document.querySelector('#add-appt-btn')?.addEventListener('click', () => modal('Add appointment', `
    <form id="appt-form" class="form-grid">
      <div class="field"><label for="appt-doctor">Doctor’s name</label><input id="appt-doctor" name="doctor" class="input" required placeholder="e.g. Dr. A. Mehta" /></div>
      <div class="field"><label for="appt-specialty">Specialty</label><input id="appt-specialty" name="specialty" class="input" value="General Medicine" /></div>
      <div class="field"><label for="appt-date">Date</label><input id="appt-date" name="date" type="date" class="input" required /></div>
      <div class="field"><label for="appt-time">Time</label><input id="appt-time" name="time" type="time" class="input" required /></div>
      <div class="field full"><label for="appt-location">Location</label><input id="appt-location" name="location" class="input" placeholder="Clinic or hospital" /></div>
      <div class="field full"><label for="appt-notes">Notes</label><textarea id="appt-notes" name="notes" class="input" rows="3"></textarea></div>
      <p class="form-error full" role="alert" tabindex="-1" hidden></p>
      <div class="full button-row"><button class="button button-primary" type="submit">Save appointment</button></div>
    </form>`));

  document.querySelector('#run-reminders-btn')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Sending…';
    try {
      const result = await api('/api/reminders/run', { method: 'POST', body: '{}' });
      await loadDashboard();
      const sent = result.results.filter((item) => item.status === 'sent').length;
      const preview = result.results.filter((item) => item.status === 'preview').length;
      const failed = result.results.filter((item) => item.status === 'failed' || item.status === 'unconfigured').length;
      const duplicates = result.results.filter((item) => item.status === 'duplicate').length;
      if (sent) toast(`${sent} reminder${sent === 1 ? '' : 's'} sent to your care circle.`);
      else if (preview) toast(`${preview} reminder${preview === 1 ? '' : 's'} prepared in preview mode.`);
      else if (duplicates) toast('Those reminders were already sent. No duplicates were created.');
      else if (failed) toast('The reminder could not be sent. Please try again.', true);
      else toast('No reminders are due right now.');
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Send reminders';
      toast(friendlyError(error.message), true);
    }
  });
}

function modal(title, body) {
  const previousFocus = document.activeElement;
  const wrapper = document.createElement('div');
  wrapper.className = 'modal-backdrop';
  wrapper.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="modal-head"><h2 id="modal-title">${escapeHtml(title)}</h2><button type="button" class="modal-close" data-close>Close</button></div>
    <div class="modal-body">${body}</div>
  </div>`;
  document.body.appendChild(wrapper);

  const close = () => {
    wrapper.remove();
    document.removeEventListener('keydown', onKey);
    previousFocus?.focus?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  wrapper.querySelector('[data-close]').addEventListener('click', close);
  wrapper.addEventListener('click', (event) => { if (event.target === wrapper) close(); });
  wrapper.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = [...wrapper.querySelectorAll('button, input, textarea, select, a[href]')].filter((element) => !element.disabled);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  const form = wrapper.querySelector('form');
  wrapper.querySelector('.modal-body input, .modal-body textarea, .modal-body select, [data-close]')?.focus();
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    const errorNode = form.querySelector('.form-error');
    submit.disabled = true;
    submit.textContent = 'Saving…';
    errorNode.hidden = true;
    try {
      const payload = Object.fromEntries(new FormData(form));
      const endpoint = form.id === 'med-form' ? '/api/medications' : '/api/appointments';
      await api(endpoint, { method: 'POST', body: JSON.stringify(payload) });
      close();
      await loadDashboard();
      toast('Saved.');
    } catch (error) {
      submit.disabled = false;
      submit.textContent = form.id === 'med-form' ? 'Save medication' : 'Save appointment';
      errorNode.textContent = friendlyError(error.message);
      errorNode.hidden = false;
      errorNode.focus();
    }
  });
}

function toast(message, error = false) {
  const node = document.createElement('div');
  node.className = `toast${error ? ' toast-error' : ''}`;
  node.setAttribute('role', error ? 'alert' : 'status');
  node.textContent = message;
  toastRegion.appendChild(node);
  setTimeout(() => node.remove(), 5000);
}

function hideChrome() {
  nav.classList.add('hidden');
  nav.innerHTML = '';
  sessionUser.classList.add('hidden');
  logoutButton.classList.add('hidden');
}

function renderLogin() {
  hideChrome();
  document.title = 'CareMesh — Sign in';
  main.setAttribute('aria-busy', 'false');
  main.innerHTML = `
    <section class="login">
      <div class="login-copy">
        <p class="eyebrow">Elder-first care</p>
        <h1>Care, connected.</h1>
        <p class="lead">Medicines, appointments and your trusted care circle — together in one calm, simple place.</p>
        <ul class="login-points">
          <li><span class="tick" aria-hidden="true">✓</span><span>One clear next step at a time</span></li>
          <li><span class="tick" aria-hidden="true">✓</span><span>Large text and easy-to-press buttons</span></li>
          <li><span class="tick" aria-hidden="true">✓</span><span>You decide who can see your care</span></li>
        </ul>
      </div>
      <div class="card login-card">
        <h2>Sign in</h2>
        <p class="row-meta">Choose who you are, then enter the 4-digit access code.</p>
        <fieldset class="role-picker">
          <legend>I am the…</legend>
          <div class="role-options">
            ${Object.entries(roleCopy).map(([role, copy]) => `<button type="button" class="role-button" data-role="${role}" aria-pressed="${role === selectedRole}">
              <span><strong>${copy.title}</strong><small>${copy.description}</small></span>
              <span class="role-selected${role === selectedRole ? '' : ' hidden'}">Selected</span>
            </button>`).join('')}
          </div>
        </fieldset>
        <form id="login-form">
          <div class="field"><label for="passcode">4-digit access code</label><input id="passcode" class="input" inputmode="numeric" autocomplete="one-time-code" maxlength="4" pattern="[0-9]{4}" placeholder="••••" required /></div>
          <p id="login-error" class="form-error" role="alert" tabindex="-1" hidden></p>
          <button class="button button-primary button-large" type="submit">Sign in</button>
        </form>
        <div class="demo-note">
          <strong>Demo access codes</strong>
          <ul><li>Elder: 1234</li><li>Caregiver: 2468</li><li>Family: 1357</li></ul>
        </div>
      </div>
    </section>`;

  document.querySelectorAll('[data-role]').forEach((button) => button.addEventListener('click', () => {
    selectedRole = button.dataset.role;
    document.querySelectorAll('[data-role]').forEach((item) => {
      const active = item === button;
      item.setAttribute('aria-pressed', String(active));
      item.querySelector('.role-selected').classList.toggle('hidden', !active);
    });
  }));

  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    const errorNode = document.querySelector('#login-error');
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    errorNode.hidden = true;
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ role: selectedRole, passcode: document.querySelector('#passcode').value }) });
      await loadDashboard();
    } catch (error) {
      submit.disabled = false;
      submit.textContent = 'Sign in';
      errorNode.textContent = friendlyError(error.message);
      errorNode.hidden = false;
      errorNode.focus();
    }
  });
}

async function loadDashboard() {
  main.setAttribute('aria-busy', 'true');
  try {
    dashboard = await api('/api/dashboard');
    renderDashboard(activeView);
  } catch {
    dashboard = null;
    hideChrome();
    renderLogin();
  }
}

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  logoutButton.disabled = false;
  dashboard = null;
  activeView = 'overview';
  history.replaceState(null, '', location.pathname);
  hideChrome();
  renderLogin();
});

window.addEventListener('hashchange', () => {
  if (!dashboard) return;
  activeView = viewFromHash();
  renderDashboard(activeView);
});

loadDashboard();
