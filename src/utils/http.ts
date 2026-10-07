import { isValidObjectId } from "mongoose";
import { CustomError } from "../errors/customError.error";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Correo normalizado (sin espacios, minúsculas): así se guarda y se busca siempre. */
export function normalizeEmail(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 200);
}

/** Correo normalizado y válido, o 400. */
export function requireEmail(value: unknown): string {
  const email = normalizeEmail(value);
  if (!email) throw new CustomError("Escribe tu correo", 400);
  if (!EMAIL_RE.test(email)) throw new CustomError("El correo no es válido", 400);
  return email;
}

export function assertObjectId(id: unknown, label = "el registro"): string {
  if (typeof id !== "string" || !isValidObjectId(id)) {
    throw new CustomError(`Identificador inválido para ${label}`, 400);
  }
  return id;
}

/** Texto recortado y sin espacios sobrantes. */
export function str(value: unknown, max = 300): string {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, max);
}

/** Entero en centavos ≥ 0. */
export function cents(value: unknown, label: string, { allowZero = true } = {}): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) {
    throw new CustomError(
      `${label} debe ser un entero en centavos${allowZero ? "" : " mayor a 0"}`,
      400,
    );
  }
  return n;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parsePage(query: any): { page: number; limit: number; skip: number } {
  const page = Math.max(1, Math.floor(Number(query?.page)) || 1);
  const limit = Math.min(100, Math.max(1, Math.floor(Number(query?.limit)) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

export function paginated<T>(items: T[], total: number, page: number, limit: number) {
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

/** Payphone y los correos esperan el teléfono internacional (+593...). */
export function toInternationalPhone(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (trimmed.startsWith("+") || digits.startsWith("593")) return `+${digits}`;
  if (digits.startsWith("0")) return `+593${digits.slice(1)}`;
  return `+593${digits}`;
}

export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function formatMoney(amount: number): string {
  return `$${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
