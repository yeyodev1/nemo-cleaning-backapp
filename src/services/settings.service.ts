import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { Settings, ISettings } from "../models/setting.model";
import { EMAIL_RE, cents, str } from "../utils/http";
import { isPayphoneEnabled } from "./payphone.service";

/** Singleton: si no existe se crea con los valores por defecto del schema. */
export async function getSettings(): Promise<ISettings> {
  const found = await Settings.findOne({ key: "main" });
  if (found) return found;
  return Settings.findOneAndUpdate(
    { key: "main" },
    { $setOnInsert: { key: "main" } },
    { upsert: true, new: true },
  ) as unknown as Promise<ISettings>;
}

function serialize(s: ISettings) {
  const o = s.toObject();
  delete (o as any).key;
  return o;
}

export async function getAdminSettings() {
  return serialize(await getSettings());
}

export async function getPublicSettings() {
  const s = await getSettings();
  return {
    businessName: s.businessName,
    bankAccounts: s.bankAccounts,
    officePricing: s.officePricing,
    bookingLeadHours: s.bookingLeadHours,
    payphoneEnabled: isPayphoneEnabled(),
  };
}

function percent(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100)
    throw new CustomError(`${label} debe estar entre 0 y 100`, 400);
  return Math.round(n);
}

export async function updateSettings(body: any) {
  const s = await getSettings();
  if (body?.businessName !== undefined)
    s.businessName = str(body.businessName, 120) || s.businessName;
  if (body?.notifyEmails !== undefined) {
    if (!Array.isArray(body.notifyEmails))
      throw new CustomError("notifyEmails debe ser una lista", 400);
    const emails = body.notifyEmails.map((e: unknown) => str(e, 200).toLowerCase()).filter(Boolean);
    const bad = emails.find((e: string) => !EMAIL_RE.test(e));
    if (bad) throw new CustomError(`Correo inválido: ${bad}`, 400);
    s.notifyEmails = emails;
  }
  if (body?.bankAccounts !== undefined) {
    if (!Array.isArray(body.bankAccounts))
      throw new CustomError("bankAccounts debe ser una lista", 400);
    s.bankAccounts = body.bankAccounts.map((a: any) => ({
      bank: str(a?.bank, 80),
      type: str(a?.type, 40),
      number: str(a?.number, 40),
      holder: str(a?.holder, 120),
      documentId: str(a?.documentId, 20),
    }));
  }
  const op = body?.officePricing;
  if (op && typeof op === "object") {
    const cur = s.officePricing;
    if (op.pricePerM2 !== undefined) cur.pricePerM2 = cents(op.pricePerM2, "pricePerM2");
    if (op.pricePerChair !== undefined)
      cur.pricePerChair = cents(op.pricePerChair, "pricePerChair");
    if (op.pricePerDesk !== undefined) cur.pricePerDesk = cents(op.pricePerDesk, "pricePerDesk");
    if (op.pricePerBathroom !== undefined)
      cur.pricePerBathroom = cents(op.pricePerBathroom, "pricePerBathroom");
    if (op.minimum !== undefined) cur.minimum = cents(op.minimum, "minimum");
    const fd = op.frequencyDiscounts;
    if (fd && typeof fd === "object") {
      if (fd.semanal !== undefined)
        cur.frequencyDiscounts.semanal = percent(fd.semanal, "El descuento semanal");
      if (fd.quincenal !== undefined)
        cur.frequencyDiscounts.quincenal = percent(fd.quincenal, "El descuento quincenal");
      if (fd.mensual !== undefined)
        cur.frequencyDiscounts.mensual = percent(fd.mensual, "El descuento mensual");
    }
    s.markModified("officePricing");
  }
  if (body?.bookingLeadHours !== undefined) {
    const n = Number(body.bookingLeadHours);
    if (!Number.isFinite(n) || n < 0 || n > 720)
      throw new CustomError("bookingLeadHours debe estar entre 0 y 720", 400);
    s.bookingLeadHours = n;
  }
  await s.save();
  return serialize(s);
}

/** A quién avisar en administración: Settings, si no NOTIFY_EMAIL, si no el admin. */
export async function notifyRecipients(): Promise<string[]> {
  const s = await getSettings();
  if (s.notifyEmails.length) return s.notifyEmails;
  if (env.NOTIFY_EMAIL) return [env.NOTIFY_EMAIL];
  return env.ADMIN_EMAIL ? [env.ADMIN_EMAIL] : [];
}
