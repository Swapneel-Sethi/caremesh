function assertString(value, field, max = 160) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new Error(`${field} is invalid`);
  return value.trim();
}

export function validateMedication(input) {
  return {
    name: assertString(input.name, 'name', 120),
    schedule: /^([01]\d|2[0-3]):[0-5]\d$/.test(input.schedule || '') ? input.schedule : (() => { throw new Error('schedule must be HH:MM'); })(),
    frequency: input.frequency ? assertString(input.frequency, 'frequency', 40) : 'Daily',
    instructions: input.instructions ? assertString(input.instructions, 'instructions', 220) : 'Follow the prescribed instructions.',
    category: input.category ? assertString(input.category, 'category', 60) : 'Routine'
  };
}

export function validateAppointment(input) {
  return {
    doctor: assertString(input.doctor, 'doctor', 120),
    specialty: input.specialty ? assertString(input.specialty, 'specialty', 80) : 'General Medicine',
    date: /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') ? input.date : (() => { throw new Error('date is invalid'); })(),
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(input.time || '') ? input.time : (() => { throw new Error('time must be HH:MM'); })(),
    location: input.location ? assertString(input.location, 'location', 160) : 'To be confirmed',
    notes: input.notes ? assertString(input.notes, 'notes', 240) : ''
  };
}
