import { CustomError } from "../errors/customError.error";
import { currentMonth, isValidMonth, monthBounds } from "./date";

/** Quincenas del negocio: Q1 = días 1–15, Q2 = 16–fin de mes (como en el Excel). */
export type Fortnight = 1 | 2;

export function fortnightOf(date: string): Fortnight {
  return Number(date.slice(8, 10)) <= 15 ? 1 : 2;
}

export function fortnightBounds(month: string, q: Fortnight): { from: string; to: string } {
  const { from, to } = monthBounds(month);
  return q === 1 ? { from, to: `${month}-15` } : { from: `${month}-16`, to };
}

/** Mes de la query o el actual; 400 si viene mal formado. */
export function monthParam(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return currentMonth();
  if (!isValidMonth(raw)) throw new CustomError("El mes debe tener el formato YYYY-MM", 400);
  return raw;
}

export function yearParam(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return Number(currentMonth().slice(0, 4));
  const y = Number(raw);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) throw new CustomError("Año inválido", 400);
  return y;
}

/** "2026-10" + n meses → "2027-01". */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Mismo día en otro mes, ajustado al último día si no existe (31 → 30/28). */
export function sameDayIn(month: string, day: number): string {
  const { to } = monthBounds(month);
  const last = Number(to.slice(8, 10));
  return `${month}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/** Tripleta Q1 / Q2 / Total que usan todas las filas del reporte quincenal. */
export interface QTotals {
  q1: number;
  q2: number;
  total: number;
}

export function qZero(): QTotals {
  return { q1: 0, q2: 0, total: 0 };
}

export function qAdd(t: QTotals, date: string, amount: number) {
  if (fortnightOf(date) === 1) t.q1 += amount;
  else t.q2 += amount;
  t.total += amount;
}

export function qRound(t: QTotals): QTotals {
  return { q1: Math.round(t.q1), q2: Math.round(t.q2), total: Math.round(t.total) };
}
