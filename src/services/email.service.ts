import { Resend } from "resend";
import { env } from "../config/env";

let resend: Resend | null = null;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(env.RESEND_API_KEY);
  return resend;
}

/** Colores reales de la marca (identidad de Instagram: marino dominante, naranja de acento, celeste). */
export const BRAND = {
  navy: "#12263F",
  orange: "#E8743B",
  orangeInk: "#B5521F",
  skyBlue: "#6FB1DE",
  ink: "#12263F",
  muted: "#5C6B7C",
  soft: "#F3F6F9",
  line: "#E1E7EE",
};

/**
 * Logo en PNG (los clientes de correo no pintan bien SVG). Lo sirve el front desde
 * `public/brand/`; es la variante oficial "sobre oscuro", va sobre el encabezado marino.
 */
const LOGO_URL = "https://nemocleaning.ec/brand/nemo-logo-sobre-oscuro-600.png";

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
  return `<p style="margin:24px 0"><a href="${href}" style="background:${BRAND.orange};color:${BRAND.navy};text-decoration:none;padding:14px 26px;border-radius:10px;font-weight:bold;font-size:15px;display:inline-block">${escapeHtml(label)} &rarr;</a></p>`;
}

/** Plantilla base: encabezado marino con el logo oficial y subrayado naranja, tarjeta blanca y pie marino con contacto real. */
export function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#F3F6F9">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F6F9;padding:32px 12px;font-family:Poppins,Arial,Helvetica,sans-serif">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:16px;overflow:hidden">
        <tr><td style="background:${BRAND.navy};padding:24px 32px 20px">
          <img src="${LOGO_URL}" width="120" alt="nemo Cleaning Services" style="display:block;width:120px;height:auto;border:0">
          <div style="width:40px;height:3px;background:${BRAND.orange};border-radius:2px;margin-top:12px;line-height:3px;font-size:0">&nbsp;</div>
        </td></tr>
        <tr><td style="padding:32px;color:${BRAND.ink};font-size:15px;line-height:1.6">
          <h1 style="margin:0 0 16px;font-family:Fraunces,Georgia,'Times New Roman',serif;font-size:26px;line-height:1.2;color:${BRAND.navy}">${escapeHtml(title)}</h1>
          ${body}
        </td></tr>
        <tr><td style="background:${BRAND.navy};padding:20px 32px;color:#C9D1D9;font-size:12px;line-height:1.7">
          <strong style="color:#fff;font-family:Fraunces,Georgia,serif;font-size:15px">Más que limpieza, restauramos valor</strong><br>
          WhatsApp <a href="https://wa.me/593967771287" style="color:#fff;text-decoration:none">0967771287</a> ·
          Instagram <a href="https://www.instagram.com/nemo_ec" style="color:#fff;text-decoration:none">@nemo_ec</a><br>
          Nemo Cleaning Services · Guayaquil, Ecuador
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}
