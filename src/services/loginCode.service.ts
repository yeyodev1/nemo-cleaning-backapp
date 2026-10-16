import crypto from "crypto";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { LoginAudience, LoginCode } from "../models/loginCode.model";
import { BRAND, escapeHtml, layout, sendEmail } from "./email.service";

/** Reglas del acceso sin contraseña (correo + código de 6 dígitos). */
export const CODE_TTL_MS = 10 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const MAX_ATTEMPTS = 5;

/** Hash con JWT_SECRET como pepper: un volcado de la base no sirve para entrar. */
export function hashLoginCode(email: string, audience: LoginAudience, code: string): string {
  return crypto
    .createHmac("sha256", env.JWT_SECRET)
    .update(`${audience}:${email}:${code}`)
    .digest("hex");
}

function newCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function codeEmail(code: string, audience: LoginAudience): string {
  const intro =
    audience === "staff"
      ? "Usa este código para ingresar al panel de Nemo Cleaning."
      : "Usa este código para ingresar a tu cuenta de Nemo Cleaning y ver tus servicios.";
  return layout(
    "Tu código de acceso",
    `<p style="margin:0 0 8px">${escapeHtml(intro)}</p>
     <p style="margin:24px 0;text-align:center">
       <span style="display:inline-block;padding:16px 28px;border-radius:14px;background:#F3F6F9;border:2px solid ${BRAND.orange};font-size:36px;font-weight:bold;letter-spacing:10px;color:${BRAND.navy};font-family:'Courier New',Courier,monospace">${escapeHtml(code)}</span>
     </p>
     <p style="margin:0 0 8px;text-align:center;color:${BRAND.muted}">El código vence en <strong>10 minutos</strong> y solo se puede usar una vez.</p>
     <p style="margin:24px 0 0;font-size:13px;color:${BRAND.muted}">Si no pediste este código, ignora este correo: nadie puede entrar sin él.</p>`,
  );
}

/**
 * Genera y envía un código. Con `deliver: false` solo deja registrada la
 * espera de reenvío (cuenta de personal inexistente): así la respuesta y el
 * 429 son iguales exista o no la cuenta.
 */
export async function issueLoginCode(
  email: string,
  audience: LoginAudience,
  { deliver }: { deliver: boolean },
): Promise<void> {
  const now = Date.now();
  const existing = await LoginCode.findOne({ email, audience }).lean();
  if (existing && now - new Date(existing.sentAt).getTime() < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil(
      (RESEND_COOLDOWN_MS - (now - new Date(existing.sentAt).getTime())) / 1000,
    );
    throw new CustomError(`Espera ${wait} segundos para pedir otro código`, 429).withCode(
      "CODE_COOLDOWN",
    );
  }

  const code = newCode();
  // Reemplaza al código anterior: pedir uno nuevo invalida el viejo.
  await LoginCode.findOneAndUpdate(
    { email, audience },
    {
      $set: {
        codeHash: deliver ? hashLoginCode(email, audience, code) : "",
        expiresAt: new Date(now + CODE_TTL_MS),
        attempts: 0,
        sentAt: new Date(now),
      },
    },
    { upsert: true },
  );
  if (!deliver) return;

  const sent = await sendEmail(
    email,
    `Tu código de acceso a Nemo Cleaning: ${code}`,
    codeEmail(code, audience),
  );
  if (!sent) {
    // Sin correo no hay forma de entrar: se libera la espera para reintentar ya.
    await LoginCode.deleteOne({ email, audience });
    throw new CustomError(
      "No pudimos enviarte el código. Inténtalo de nuevo en unos minutos",
      502,
    ).withCode("CODE_EMAIL_FAILED");
  }
}

/**
 * Verifica y consume el código. Lanza 400 si no coincide o venció y 429 al
 * agotar los intentos. Si coincide, el código se borra (un solo uso).
 */
export async function consumeLoginCode(
  email: string,
  audience: LoginAudience,
  codeRaw: unknown,
): Promise<void> {
  const code = String(codeRaw ?? "").replace(/\D/g, "");
  if (code.length !== 6) throw new CustomError("Escribe el código de 6 dígitos", 400);

  const doc = await LoginCode.findOne({ email, audience });
  const expired = new CustomError(
    "El código venció o ya no es válido. Pide uno nuevo",
    400,
  ).withCode("CODE_EXPIRED");
  if (!doc || !doc.codeHash || doc.expiresAt.getTime() <= Date.now()) throw expired;
  if (doc.attempts >= MAX_ATTEMPTS) {
    throw new CustomError("Superaste los intentos permitidos. Pide un código nuevo", 429).withCode(
      "CODE_LOCKED",
    );
  }

  if (safeEqual(doc.codeHash, hashLoginCode(email, audience, code))) {
    // Borrado condicionado: dos verificaciones simultáneas no entran las dos.
    const { deletedCount } = await LoginCode.deleteOne({
      _id: doc._id,
      codeHash: doc.codeHash,
      attempts: { $lt: MAX_ATTEMPTS },
    });
    if (deletedCount !== 1) throw expired;
    return;
  }

  const updated = await LoginCode.findOneAndUpdate(
    { _id: doc._id, attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { new: true },
  ).lean();
  const left = MAX_ATTEMPTS - (updated?.attempts ?? MAX_ATTEMPTS);
  if (left <= 0) {
    // Se conserva el documento sin hash para que la espera de reenvío siga contando.
    await LoginCode.updateOne({ _id: doc._id }, { $set: { codeHash: "" } });
    throw new CustomError(
      "Código incorrecto. Superaste los intentos: pide un código nuevo",
      429,
    ).withCode("CODE_LOCKED");
  }
  throw new CustomError(
    `Código incorrecto. Te ${left === 1 ? "queda 1 intento" : `quedan ${left} intentos`}`,
    400,
  ).withCode("CODE_INVALID");
}
