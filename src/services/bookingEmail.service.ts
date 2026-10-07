import { env } from "../config/env";
import { Booking } from "../models/booking.model";
import { Branch } from "../models/branch.model";
import { Customer } from "../models/customer.model";
import { User } from "../models/user.model";
import { formatMoney } from "../utils/http";
import { BRAND, button, escapeHtml, layout, sendEmail } from "./email.service";
import { getSettings, notifyRecipients } from "./settings.service";

/**
 * Correos del ciclo del pedido. Todas las funciones son "fire and log": nunca
 * lanzan, porque un correo caído no puede tumbar un pedido o un pago ya guardado.
 */

const METHOD_LABEL: Record<string, string> = {
  card: "Tarjeta",
  cash: "Efectivo",
  transfer: "Transferencia",
  whatsapp: "Por coordinar por WhatsApp",
};

/** Origen legible para el aviso al equipo. */
function sourceLabel(b: { source?: string; history?: { by?: string }[] }): string {
  if (b.source === "whatsapp")
    return b.history?.[0]?.by === "Cliente (web)"
      ? "Web · termina por WhatsApp"
      : "WhatsApp (pedido rápido del panel)";
  if (b.source === "web") return "Web";
  return "Panel";
}
const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

export function trackingUrl(code: string, accessToken: string): string {
  return `${env.FRONTEND_URL}/pedido/${encodeURIComponent(code)}?token=${encodeURIComponent(accessToken)}`;
}

function humanDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]}`;
}

async function loadContext(bookingId: string) {
  const booking = await Booking.findById(bookingId).select("+accessToken").lean();
  if (!booking) return null;
  const [customer, branch, operators] = await Promise.all([
    Customer.findById(booking.customer).lean(),
    Branch.findById(booking.branch).lean(),
    User.find({ _id: { $in: booking.operators } })
      .select("name email phone")
      .lean(),
  ]);
  return {
    booking,
    customer,
    branch,
    operators,
    link: trackingUrl(booking.code, booking.accessToken),
  };
}

type Ctx = NonNullable<Awaited<ReturnType<typeof loadContext>>>;

function summary(ctx: Ctx, { prices = true } = {}): string {
  const b = ctx.booking;
  const rows = b.items
    .map(
      (i) =>
        `<tr><td style="padding:6px 0">${escapeHtml(i.name)}${i.variant ? ` · ${escapeHtml(i.variant)}` : ""} × ${i.quantity}${i.unit === "m2" ? " m²" : ""}</td>${prices ? `<td align="right" style="padding:6px 0;color:${BRAND.navy};font-weight:bold">${formatMoney(i.subtotal)}</td>` : ""}</tr>`,
    )
    .join("");
  // Muebles con rango ($15 – $20): se cobra el menor y el catálogo pide avisarlo.
  const rangeNote =
    prices && b.items.some((i) => (i.unitPriceMax ?? 0) > i.unitPrice)
      ? `<tr><td colspan="2" style="padding:4px 0 8px;font-size:12px;color:${BRAND.muted}">El valor final se confirma según el estado/material del mueble.</td></tr>`
      : "";
  const totals = prices
    ? `${b.discount ? `<tr><td style="padding:6px 0;color:${BRAND.muted}">Descuento</td><td align="right">-${formatMoney(b.discount)}</td></tr>` : ""}
       <tr><td style="padding:8px 0;font-weight:bold;border-top:1px solid #E1E7EE">Total</td><td align="right" style="padding:8px 0;font-weight:bold;border-top:1px solid #E1E7EE">${formatMoney(b.total)}</td></tr>`
    : "";
  return `
  <p style="margin:0 0 8px"><strong>Pedido:</strong> ${escapeHtml(b.code)}<br>
  <strong>Fecha:</strong> ${escapeHtml(humanDate(b.date))}, ${escapeHtml(b.time)}<br>
  <strong>Sucursal:</strong> ${escapeHtml(ctx.branch?.name ?? "")}<br>
  ${b.address ? `<strong>Dirección:</strong> ${escapeHtml(b.address)}${b.reference ? ` (${escapeHtml(b.reference)})` : ""}<br>` : ""}
  <strong>Pago:</strong> ${METHOD_LABEL[b.paymentMethod] ?? b.paymentMethod}</p>
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:12px 0">${rows}${rangeNote}${totals}</table>`;
}

async function bankBlock(): Promise<string> {
  const s = await getSettings();
  if (!s.bankAccounts.length) return "";
  const accounts = s.bankAccounts
    .map(
      (a) =>
        `<p style="margin:0 0 8px">${escapeHtml(a.bank)} · ${escapeHtml(a.type)} N.º <strong>${escapeHtml(a.number)}</strong><br>${escapeHtml(a.holder)}${a.documentId ? ` · ${escapeHtml(a.documentId)}` : ""}</p>`,
    )
    .join("");
  return `<div style="background:#F3F6F9;border-radius:12px;padding:16px;margin:16px 0"><p style="margin:0 0 8px;font-weight:bold;color:${BRAND.navy}">Datos para transferencia</p>${accounts}</div>`;
}

async function safe(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    console.error(`[email] ${label} falló:`, error);
  }
}

export function sendBookingCreated(bookingId: string) {
  return safe("pedido creado", async () => {
    const ctx = await loadContext(bookingId);
    if (!ctx) return;
    const b = ctx.booking;
    let payText = "";
    if (b.paymentMethod === "transfer") {
      payText = b.transferProofUrl
        ? "<p>Recibimos tu comprobante de transferencia. Lo revisaremos y te confirmaremos el pago.</p>"
        : `<p>Realiza la transferencia y sube el comprobante desde el enlace de seguimiento.</p>${await bankBlock()}`;
    } else if (b.paymentMethod === "cash") {
      payText = "<p>Pagas en efectivo el día del servicio.</p>";
    } else if (b.paymentMethod === "whatsapp") {
      payText =
        "<p>Coordinamos contigo el pago por WhatsApp. Si prefieres, también puedes pagar con tarjeta desde el enlace de seguimiento.</p>";
    } else {
      payText =
        "<p>Si aún no completaste el pago con tarjeta, puedes hacerlo desde el enlace de seguimiento.</p>";
    }
    const name = escapeHtml(ctx.customer?.name?.split(" ")[0] ?? "");
    const html = layout(
      "¡Recibimos tu pedido!",
      `<p>Hola ${name}, gracias por confiar en Nemo Cleaning. Este es el resumen de tu pedido:</p>
       ${summary(ctx)}${payText}
       ${button("Ver mi pedido", ctx.link)}
       <p style="color:${BRAND.muted};font-size:13px">Te avisaremos cuando confirmemos tu pedido.</p>`,
    );
    await sendEmail(ctx.customer?.email ?? "", `Pedido ${b.code} recibido — Nemo Cleaning`, html);

    const isWhatsapp = b.source === "whatsapp";
    const admin = layout(
      isWhatsapp ? `Nuevo pedido por WhatsApp ${b.code}` : `Nuevo pedido ${b.code}`,
      `<p><strong>Cliente:</strong> ${escapeHtml(ctx.customer?.name)} · ${escapeHtml(ctx.customer?.phone)} · ${escapeHtml(ctx.customer?.email)}</p>
       ${summary(ctx)}
       ${isWhatsapp ? `<p style="padding:10px 12px;border-radius:10px;background:#E7F8EE;color:#14663A"><strong>Pedido por WhatsApp:</strong> el cliente coordina el pago en el chat. Confírmalo desde el panel → Pedidos por WhatsApp.</p>` : ""}
       <p><strong>Origen:</strong> ${sourceLabel(b)}${b.notes ? `<br><strong>Notas:</strong> ${escapeHtml(b.notes)}` : ""}</p>
       ${b.transferProofUrl ? button("Ver comprobante", b.transferProofUrl) : ""}`,
    );
    await sendEmail(
      await notifyRecipients(),
      `${isWhatsapp ? "Nuevo pedido por WhatsApp" : "Nuevo pedido"} ${b.code} · ${ctx.branch?.name ?? ""}`,
      admin,
    );
  });
}

export function sendBookingConfirmed(bookingId: string) {
  return safe("pedido confirmado", async () => {
    const ctx = await loadContext(bookingId);
    if (!ctx) return;
    const html = layout(
      "Tu pedido está confirmado",
      `<p>Hola ${escapeHtml(ctx.customer?.name?.split(" ")[0] ?? "")}, confirmamos tu servicio:</p>${summary(ctx)}${button("Ver mi pedido", ctx.link)}`,
    );
    await sendEmail(
      ctx.customer?.email ?? "",
      `Pedido ${ctx.booking.code} confirmado — Nemo Cleaning`,
      html,
    );
  });
}

export function sendPaymentApproved(bookingId: string, amount: number) {
  return safe("pago aprobado", async () => {
    const ctx = await loadContext(bookingId);
    if (!ctx) return;
    const b = ctx.booking;
    const html = layout(
      "Pago recibido",
      `<p>Registramos tu pago de <strong>${formatMoney(amount)}</strong> para el pedido ${escapeHtml(b.code)}.</p>
       <p>${b.balance > 0 ? `Saldo pendiente: <strong>${formatMoney(b.balance)}</strong>.` : "Tu pedido está pagado por completo."}</p>
       ${summary(ctx)}${button("Ver mi pedido", ctx.link)}`,
    );
    await sendEmail(ctx.customer?.email ?? "", `Pago recibido · ${b.code} — Nemo Cleaning`, html);
  });
}

export function sendTransferRejected(bookingId: string, note: string) {
  return safe("transferencia rechazada", async () => {
    const ctx = await loadContext(bookingId);
    if (!ctx) return;
    const html = layout(
      "No pudimos validar tu transferencia",
      `<p>Revisamos el comprobante del pedido ${escapeHtml(ctx.booking.code)} y no pudimos validarlo.</p>
       ${note ? `<p><strong>Motivo:</strong> ${escapeHtml(note)}</p>` : ""}
       <p>Puedes subir un nuevo comprobante desde el enlace de seguimiento o escribirnos por WhatsApp.</p>
       ${await bankBlock()}${button("Subir comprobante", ctx.link)}`,
    );
    await sendEmail(
      ctx.customer?.email ?? "",
      `Revisa tu pago · ${ctx.booking.code} — Nemo Cleaning`,
      html,
    );
  });
}

export function sendOperatorAssigned(bookingId: string, operatorIds: string[]) {
  return safe("operador asignado", async () => {
    if (!operatorIds.length) return;
    const ctx = await loadContext(bookingId);
    if (!ctx) return;
    const b = ctx.booking;
    const targets = ctx.operators.filter((o) => operatorIds.includes(String(o._id)));
    for (const op of targets) {
      const html = layout(
        "Tienes un nuevo servicio asignado",
        `<p>Hola ${escapeHtml(op.name.split(" ")[0])}, se te asignó este servicio:</p>
         ${summary(ctx, { prices: false })}
         <p><strong>Cliente:</strong> ${escapeHtml(ctx.customer?.name)}<br><strong>Teléfono:</strong> ${escapeHtml(ctx.customer?.phone)}</p>
         ${b.notes ? `<p><strong>Notas:</strong> ${escapeHtml(b.notes)}</p>` : ""}
         ${button("Ver mis servicios", `${env.FRONTEND_URL}/admin`)}`,
      );
      await sendEmail(
        op.email,
        `Servicio asignado ${b.code} · ${humanDate(b.date)} ${b.time}`,
        html,
      );
    }
  });
}

export function sendRescheduled(bookingId: string, previous: { date: string; time: string }) {
  return safe("reprogramado", async () => {
    const ctx = await loadContext(bookingId);
    if (!ctx) return;
    const b = ctx.booking;
    const before = `${humanDate(previous.date)}, ${previous.time}`;
    const html = layout(
      "Tu pedido fue reprogramado",
      `<p>El pedido ${escapeHtml(b.code)} cambió de fecha.</p>
       <p><span style="color:${BRAND.muted};text-decoration:line-through">${escapeHtml(before)}</span><br>
       <strong>Nueva fecha: ${escapeHtml(humanDate(b.date))}, ${escapeHtml(b.time)}</strong></p>${summary(ctx)}${button("Ver mi pedido", ctx.link)}`,
    );
    await sendEmail(
      ctx.customer?.email ?? "",
      `Pedido ${b.code} reprogramado — Nemo Cleaning`,
      html,
    );
    const opHtml = layout(
      "Servicio reprogramado",
      `<p>El servicio ${escapeHtml(b.code)} pasó de ${escapeHtml(before)} a <strong>${escapeHtml(humanDate(b.date))}, ${escapeHtml(b.time)}</strong>.</p>${summary(ctx, { prices: false })}`,
    );
    await sendEmail(
      ctx.operators.map((o) => o.email),
      `Servicio ${b.code} reprogramado`,
      opHtml,
    );
  });
}

export function sendCancelled(bookingId: string, reason: string) {
  return safe("cancelado", async () => {
    const ctx = await loadContext(bookingId);
    if (!ctx) return;
    const b = ctx.booking;
    const html = layout(
      "Tu pedido fue cancelado",
      `<p>El pedido ${escapeHtml(b.code)} del ${escapeHtml(humanDate(b.date))}, ${escapeHtml(b.time)} fue cancelado.</p>
       ${reason ? `<p><strong>Motivo:</strong> ${escapeHtml(reason)}</p>` : ""}
       ${b.amountPaid > 0 ? "<p>Nos comunicaremos contigo para coordinar la devolución de lo pagado.</p>" : ""}
       <p>Si fue un error, escríbenos y lo reagendamos.</p>`,
    );
    await sendEmail(ctx.customer?.email ?? "", `Pedido ${b.code} cancelado — Nemo Cleaning`, html);
    const opHtml = layout(
      "Servicio cancelado",
      `<p>El servicio ${escapeHtml(b.code)} del ${escapeHtml(humanDate(b.date))}, ${escapeHtml(b.time)} fue cancelado.</p>`,
    );
    await sendEmail(
      ctx.operators.map((o) => o.email),
      `Servicio ${b.code} cancelado`,
      opHtml,
    );
    await sendEmail(await notifyRecipients(), `Pedido ${b.code} cancelado`, opHtml);
  });
}

export function sendOfficeQuote(quote: any) {
  return safe("cotización de oficina", async () => {
    const PLAN: Record<string, string> = {
      basico: "Básico",
      profundo: "Profundo",
      mensual: "Plan mensual",
    };
    const special = quote.estimate === null || quote.estimate === undefined;
    const rows = (quote.breakdown ?? [])
      .map(
        (r: any) =>
          `<tr><td style="padding:6px 0">${escapeHtml(r.label)}</td><td align="right">${formatMoney(r.amount)}</td></tr>`,
      )
      .join("");
    const table = special
      ? `<p style="background:${BRAND.soft};border-radius:12px;padding:16px">Elegiste el <strong>plan mensual</strong>: tiene tarifa especial, así que nuestro equipo te contactará para cotizarlo.</p>`
      : `<table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:12px 0">${rows}
      <tr><td style="padding:8px 0;font-weight:bold;border-top:1px solid #E1E7EE">Estimado</td><td align="right" style="font-weight:bold;color:${BRAND.navy};border-top:1px solid #E1E7EE">${formatMoney(quote.estimate)}</td></tr></table>`;
    const extras = [
      quote.chairsFabric ? `${quote.chairsFabric} sillas de tela` : "",
      quote.chairsMixed ? `${quote.chairsMixed} sillas mixtas` : "",
      quote.windows ? `${quote.windows} ventanales` : "",
      quote.bathrooms ? `${quote.bathrooms} baños` : "",
    ].filter(Boolean);
    const html = layout(
      `Tu cotización ${quote.code}`,
      `<p>Hola ${escapeHtml(String(quote.contact?.name ?? "").split(" ")[0])}, ${special ? "recibimos tu solicitud para la limpieza de tu oficina." : "este es el estimado para la limpieza de tu oficina:"}</p>${table}
       ${special ? "" : `<p style="color:${BRAND.muted};font-size:13px">Calculado con las tarifas de nuestro catálogo. Te contactaremos para confirmar los detalles.</p>`}`,
    );
    await sendEmail(quote.contact?.email ?? "", `Cotización ${quote.code} — Nemo Cleaning`, html);
    const admin = layout(
      `Nueva cotización de oficina ${quote.code}`,
      `<p><strong>${escapeHtml(quote.contact?.name)}</strong>${quote.contact?.company ? ` · ${escapeHtml(quote.contact.company)}` : ""}<br>
       ${escapeHtml(quote.contact?.phone)} · ${escapeHtml(quote.contact?.email)}</p>
       <p>${quote.squareMeters} m² · ${escapeHtml(PLAN[quote.plan] ?? quote.plan)}${extras.length ? ` · ${escapeHtml(extras.join(" · "))}` : ""}</p>
       ${quote.notes ? `<p><strong>Observaciones:</strong> ${escapeHtml(quote.notes)}</p>` : ""}${table}`,
    );
    await sendEmail(await notifyRecipients(), `Nueva cotización de oficina ${quote.code}`, admin);
  });
}
