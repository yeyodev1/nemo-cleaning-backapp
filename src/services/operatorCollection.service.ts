
import { CustomError } from "../errors/customError.error";
import { Booking } from "../models/booking.model";
import { SessionUser } from "../types/AuthRequest";
import { assertObjectId, str } from "../utils/http";
import { actor, assertBranchAccess, branchFilter } from "../utils/scope";
import { addManualPayment } from "./payment.service";

/**
 * Cobros que reportan los operadores al terminar un servicio:
 *   - EFECTIVO: el operador escribe cuánto recibió; el administrador de la sucursal o gerencia
 *     marca que le entregó ese efectivo (se registra el pago en efectivo).
 *   - TRANSFERENCIA: el operador solo avisa; la oficina sube la imagen del comprobante y
 *     confirma (se registra el pago por transferencia con su comprobante).
 */

const PROOF_RE = /^https:\/\/res\.cloudinary\.com\/\S+$/;

function row(b: any) {
  const r = b.closeReport;
  return {
    _id: String(b._id),
    code: b.code,
    date: b.date,
    time: b.time,
    branch: String(b.branch),
    customer: b.customer ? { name: b.customer.name, phone: b.customer.phone } : null,
    operators: (b.operators ?? []).map((o: any) => ({ _id: String(o._id), name: o.name, color: o.color })),
    total: b.total,
    balance: b.balance,
    paymentAccount: b.paymentAccount ?? "",
    method: r.method,
    cashReceived: r.cashReceived ?? 0,
    reportedAt: r.at,
    reportedBy: r.by?.name ?? "",
    handedTo: r.handedTo ?? null,
    receivedAt: r.receivedAt ?? null,
    receivedBy: r.receivedBy?.name ?? "",
    receivedAmount: r.receivedAmount ?? 0,
    proofUrl: r.proofUrl ?? "",
  };
}

/** GET /admin/collections?status=pending|done — pendientes, o recibidos en los últimos 30 días. */
export async function listCollections(user: SessionUser, query: any) {
  const done = query?.status === "done";
  // "Para mí": el efectivo que el operador dijo que me entrega a mí.
  const mine = query?.mine === "1" ? { "closeReport.handedTo.id": user.id } : {};
  const filter: Record<string, any> = {
    ...mine,
    ...branchFilter(user, query?.branch),
    "closeReport.method": { $in: ["cash", "transfer"] },
    "closeReport.receivedAt": done ? { $gte: new Date(Date.now() - 30 * 86_400_000) } : null,
  };
  const items = await Booking.find(filter)
    .sort(done ? { "closeReport.receivedAt": -1 } : { date: 1, time: 1 })
    .limit(500)
    .populate("customer", "name phone")
    .populate("operators", "name color")
    .lean();
  const rows = items.map(row);
  const cash = rows.filter((r) => r.method === "cash");
  return {
    items: rows,
    summary: {
      cashCount: cash.length,
      cashTotal: cash.reduce((s, r) => s + (done ? r.receivedAmount : r.cashReceived), 0),
      transferCount: rows.length - cash.length,
    },
  };
}

/**
 * POST /admin/collections/:id/receive — `{ amount?, proofUrl?, note? }`.
 * Efectivo: monto = lo que entregó el operador (por defecto lo que reportó).
 * Transferencia: exige la imagen del comprobante; monto por defecto = saldo del servicio.
 */
export async function receiveCollection(id: string, body: any, user: SessionUser) {
  const booking = await Booking.findById(assertObjectId(id, "el servicio"));
  if (!booking) throw new CustomError("Servicio no encontrado", 404);
  assertBranchAccess(user, booking.branch);
  const report = booking.closeReport;
  if (!report) throw new CustomError("Este servicio no tiene cobro reportado por el operador", 409);
  if (report.receivedAt) throw new CustomError("Este cobro ya fue recibido", 409);
  // El efectivo lo recibe la persona a quien el operador dijo que se lo entrega (o gerencia).
  if (report.method === "cash" && report.handedTo?.id && user.role !== "admin" && report.handedTo.id !== user.id) {
    throw new CustomError(`Este efectivo se lo entregan a ${report.handedTo.name}`, 403);
  }

  const isCash = report.method === "cash";
  const fallback = isCash ? report.cashReceived : booking.balance;
  const amount = body?.amount !== undefined && body?.amount !== "" ? Number(body.amount) : fallback;
  if (!Number.isInteger(amount) || amount < 0) throw new CustomError("El monto debe estar en centavos", 400);
  const proofUrl = str(body?.proofUrl, 500);
  if (!isCash && !PROOF_RE.test(proofUrl)) throw new CustomError("Sube la imagen del comprobante de la transferencia", 400);
  if (proofUrl && !PROOF_RE.test(proofUrl)) throw new CustomError("Comprobante inválido", 400);

  const by = actor(user)!;
  const operatorNames = await Booking.findById(booking._id).populate("operators", "name").select("operators").lean();
  const who = (operatorNames?.operators as any[] | undefined)?.map((o) => o.name).join(", ") || report.by?.name || "el operador";
  if (amount > 0) {
    await addManualPayment(
      String(booking._id),
      {
        amount,
        method: isCash ? "cash" : "transfer",
        cashConfirmed: isCash,
        proofUrl,
        account: isCash ? "Efectivo" : booking.paymentAccount?.toLowerCase().startsWith("transferencia") ? booking.paymentAccount : "",
        note: [isCash ? `Efectivo entregado por ${who}` : `Transferencia reportada por ${who}`, str(body?.note, 300)].filter(Boolean).join(" · "),
      },
      user,
    );
  }
  await Booking.updateOne(
    { _id: booking._id },
    {
      $set: {
        "closeReport.receivedAt": new Date(),
        "closeReport.receivedBy": by,
        "closeReport.receivedAmount": amount,
        "closeReport.proofUrl": proofUrl,
      },
      $push: {
        history: {
          at: new Date(),
          by: by.name,
          action: "updated",
          note: isCash ? `Recibió $${(amount / 100).toFixed(2)} en efectivo de ${who}` : `Confirmó la transferencia con comprobante`,
        },
      },
    },
  );
  const fresh = await Booking.findById(booking._id).populate("customer", "name phone").populate("operators", "name color").lean();
  return row(fresh);
}

/** Cuántos cobros esperan en las sucursales del usuario (para el contador del menú). */
export async function pendingCount(user: SessionUser) {
  const n = await Booking.countDocuments({
    ...branchFilter(user),
    "closeReport.method": { $in: ["cash", "transfer"] },
    "closeReport.receivedAt": null,
  });
  return { count: n };
}

