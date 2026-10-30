/** Utilidades de zona horaria. En BD todo va en UTC; aquí se convierte solo para reglas de horario. */

export function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Desfase (ms) de la zona respecto a UTC en ese instante. */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Instante UTC que corresponde a una hora local (año, mes, día, hora) en la zona. */
export function zonedTimeToUtc(y: number, m: number, d: number, hour: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hour));
  return new Date(guess.getTime() - offsetMs(guess, timeZone));
}

/** Clave del día local (YYYY-MM-DD) para contar mensajes por día. */
export function localDayKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Lunes (fecha local) de la semana del instante, como clave YYYY-MM-DD. */
export function weekKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  const local = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dow = (local.getUTCDay() + 6) % 7; // 0 = lunes
  local.setUTCDate(local.getUTCDate() - dow);
  return local.toISOString().slice(0, 10);
}
