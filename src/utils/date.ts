/**
 * Guayaquil está en UTC-5 todo el año (sin horario de verano), así que basta un
 * desfase fijo: no hace falta una librería de zonas horarias.
 */
export const TZ_OFFSET = "-05:00";
const OFFSET_MS = 5 * 60 * 60 * 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function isValidTime(value: unknown): value is string {
  return typeof value === "string" && TIME_RE.test(value);
}

export function isValidMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH_RE.test(value);
}

/** "YYYY-MM-DD" de un instante, en hora de Guayaquil. */
export function dateStrOf(at: Date): string {
  return new Date(at.getTime() - OFFSET_MS).toISOString().slice(0, 10);
}

export function todayStr(): string {
  return dateStrOf(new Date());
}

export function currentMonth(): string {
  return todayStr().slice(0, 7);
}

/** Instante de una fecha + hora locales de Guayaquil. */
export function toDateTime(date: string, time: string): Date {
  return new Date(`${date}T${time}:00${TZ_OFFSET}`);
}

/** [inicio, fin) del día local en UTC. */
export function dayRange(date: string): { start: Date; end: Date } {
  const start = toDateTime(date, "00:00");
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Día de la semana (0 = domingo) de una fecha local. */
export function weekDayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function timeOf(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Lista de fechas from..to inclusive (con tope para no armar arreglos gigantes). */
export function daysBetween(from: string, to: string, max = 366): string[] {
  const out: string[] = [];
  let cur = from;
  while (cur <= to && out.length < max) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/**
 * Rango de fechas desde la query (?from=&to=). Sin valores: el mes en curso.
 * Devuelve strings locales y los instantes UTC equivalentes.
 */
export function parseRange(fromRaw: unknown, toRaw: unknown) {
  const month = monthBounds(currentMonth());
  const from = isValidDate(fromRaw) ? fromRaw : month.from;
  const to = isValidDate(toRaw) ? toRaw : month.to;
  if (from > to) return { from: to, to: from, start: dayRange(to).start, end: dayRange(from).end };
  return { from, to, start: dayRange(from).start, end: dayRange(to).end };
}
