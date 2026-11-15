import crypto from 'node:crypto';
import { hashPasscode } from './security.mjs';

const users = [
  { id: 'usr-elder', name: 'Meera Rao', role: 'elder', initials: 'MR', email: 'meera.demo@example.com', passcode: '1234' },
  { id: 'usr-caregiver', name: 'Priya Shah', role: 'caregiver', initials: 'PS', email: 'priya.demo@example.com', passcode: '2468' },
  { id: 'usr-family', name: 'Arjun Rao', role: 'family', initials: 'AR', email: 'arjun.demo@example.com', passcode: '1357' }
].map((user) => {
  const { passcode, ...rest } = user;
  const credential = hashPasscode(passcode, `caremesh-${user.id}`);
  return { ...rest, ...credential };
});

const state = {
  profiles: [
    { id: 'profile-elder', name: 'Meera Rao', age: 72, emergencyContact: 'Arjun Rao', primaryDoctor: 'Dr. Ananya Mehta', notes: 'Prefers short, direct instructions and large touch targets.' }
  ],
  medications: [
    { id: 'med-1', name: 'Metformin 500 mg', schedule: '08:00', frequency: 'Daily', status: 'taken', ownerId: 'profile-elder', nextDue: 'Today · 08:00', instructions: 'Take with breakfast.', category: 'Routine' },
    { id: 'med-2', name: 'Amlodipine 5 mg', schedule: '13:00', frequency: 'Daily', status: 'taken', ownerId: 'profile-elder', nextDue: 'Today · 13:00', instructions: 'Take after lunch.', category: 'Routine' },
    { id: 'med-3', name: 'Vitamin D3 1000 IU', schedule: '20:00', frequency: 'Daily', status: 'pending', ownerId: 'profile-elder', nextDue: 'Today · 20:00', instructions: 'Take after dinner.', category: 'Routine' }
  ],
  appointments: [
    { id: 'appt-1', doctor: 'Dr. Ananya Mehta', specialty: 'Cardiology', date: '2026-11-15', time: '16:30', location: 'Apollo Clinic · Bandra', status: 'confirmed', notes: 'Carry previous prescription.' },
    { id: 'appt-2', doctor: 'Dr. Vivek Shah', specialty: 'Physiotherapy', date: '2026-11-18', time: '11:00', location: 'CareWell Rehab', status: 'upcoming', notes: 'Bring walking assessment.' }
  ],
  careTeam: [
    { id: 'team-1', name: 'Priya Shah', role: 'Caregiver', access: 'medications + appointments + alerts', avatar: 'PS' },
    { id: 'team-2', name: 'Arjun Rao', role: 'Family', access: 'view + alerts', avatar: 'AR' }
  ],
  events: [
    { id: crypto.randomUUID(), at: '09:14', title: 'Morning medication confirmed', actor: 'Meera Rao', type: 'medication', detail: 'Metformin 500 mg' },
    { id: crypto.randomUUID(), at: '08:40', title: 'Appointment reminder queued', actor: 'CarePulse', type: 'reminder', detail: 'Cardiology · 16:30' },
    { id: crypto.randomUUID(), at: 'Yesterday', title: 'Caregiver access reviewed', actor: 'Meera Rao', type: 'security', detail: 'Priya Shah' }
  ],
  outbox: [],
  reminders: []
};

export function getState() { return state; }
export function getUsers() { return users; }
export function getUserById(id) { return users.find((user) => user.id === id) || null; }

export function addEvent(event) {
  state.events.unshift({ id: crypto.randomUUID(), ...event });
  state.events = state.events.slice(0, 50);
}

export function addMedication(input) {
  const medication = {
    id: crypto.randomUUID(),
    name: input.name,
    schedule: input.schedule,
    frequency: input.frequency || 'Daily',
    status: 'pending',
    ownerId: 'profile-elder',
    nextDue: `Today · ${input.schedule}`,
    instructions: input.instructions || 'Follow the prescribed instructions.',
    category: input.category || 'Routine'
  };
  state.medications.unshift(medication);
  return medication;
}

export function updateMedication(id, patch) {
  const medication = state.medications.find((item) => item.id === id);
  if (!medication) return null;
  Object.assign(medication, patch);
  return medication;
}

export function addAppointment(input) {
  const appointment = {
    id: crypto.randomUUID(),
    doctor: input.doctor,
    specialty: input.specialty || 'General Medicine',
    date: input.date,
    time: input.time,
    location: input.location || 'To be confirmed',
    status: 'upcoming',
    notes: input.notes || ''
  };
  state.appointments.push(appointment);
  return appointment;
}
