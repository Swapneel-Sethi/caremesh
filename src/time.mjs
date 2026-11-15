const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const values = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

export function localParts(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = zonedParts(date, timeZone);
  return { ...parts, minutes: parts.hour * 60 + parts.minute };
}

export function localDateKey(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  return zonedParts(date, timeZone).date;
}

export function timeLabel(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const { hour, minute } = zonedParts(date, timeZone);
  const suffix = hour >= 12 ? 'pm' : 'am';
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function clockLabel(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const { hour, minute } = zonedParts(date, timeZone);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

export function scheduleLabel(value) {
  const minutes = timeToMinutes(value);
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  const suffix = hour >= 12 ? 'pm' : 'am';
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function dateLong(value) {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC'
  });
}

export function dayOffset(fromDate, toDate) {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}
