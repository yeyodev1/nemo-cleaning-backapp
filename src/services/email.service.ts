import { Resend } from "resend";
import { env } from "../config/env";

let resend: Resend | null = null;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(env.RESEND_API_KEY);
  return resend;
}

export const BRAND = { blue: "#0B4F8A", aqua: "#19C3B8", ink: "#0F172A", muted: "#64748B" };

/**
 * Envía un correo. Nunca lanza: el fallo de un correo no debe romper el pedido
 * o el pago que lo disparó. Devuelve si Resend lo aceptó.
 */
export async function sendEmail(
  to: string | string[],
  subject: string,
  html: string,
): Promise<boolean> {
  const recipients = (Array.isArray(to) ? to : [to])
    .map((t) => String(t || "").trim())
    .filter(Boolean);
  if (!recipients.length) return false;
  const client = getClient();
  if (!client) {
    console.warn(`[email] RESEND_API_KEY no definida — no se envió "${subject}"`);
    return false;
  }
  try {
    const { error } = await client.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to: recipients,
      subject,
      html,
    });
    if (error) {
      console.error("[email] Resend rechazó el envío:", error);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[email] falló el envío:", error);
    return false;
  }
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function button(label: string, href: string): string {
  return `<p style="margin:24px 0"><a href="${href}" style="background:${BRAND.aqua};color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:bold;display:inline-block">${escapeHtml(label)}</a></p>`;
}

/** Plantilla base: tarjeta blanca centrada con encabezado azul Nemo. */
export function layout(title: string, body: string): string {
  return `<!doctype html><html><body style="margin:0">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#EEF6FB;padding:32px 0;font-family:Arial,Helvetica,sans-serif">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:16px;overflow:hidden">
        <tr><td style="background:${BRAND.blue};color:#fff;padding:20px 32px;font-size:20px;font-weight:bold">Nemo Cleaning <span style="color:${BRAND.aqua}">Services</span></td></tr>
        <tr><td style="height:4px;background:${BRAND.aqua}"></td></tr>
        <tr><td style="padding:32px;color:${BRAND.ink};font-size:15px;line-height:1.6">
          <h1 style="margin:0 0 16px;font-size:22px;color:${BRAND.blue}">${escapeHtml(title)}</h1>
          ${body}
        </td></tr>
        <tr><td style="padding:16px 32px;color:${BRAND.muted};font-size:12px;border-top:1px solid #E2E8F0">© ${new Date().getFullYear()} Nemo Cleaning Services · Guayaquil, Ecuador</td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}
