import crypto from "crypto";

const KEY_LEN = 64;
export const MIN_PASSWORD = 6;

/** Valida la contraseña nueva (texto) o lanza el mensaje para el usuario. */
export function requirePassword(raw: unknown): string {
  const password = String(raw ?? "");
  if (password.length < MIN_PASSWORD) throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
  if (password.length > 128) throw new Error("La contraseña es demasiado larga");
  return password;
}

/** Hash con scrypt y sal aleatoria: `scrypt$<sal>$<hash>` (hex). */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEY_LEN).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

/** Compara en tiempo constante. Un hash en otro formato (legado) nunca coincide. */
export function verifyPassword(password: string, stored: string | undefined): boolean {
  const [scheme, salt, hash] = String(stored ?? "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
