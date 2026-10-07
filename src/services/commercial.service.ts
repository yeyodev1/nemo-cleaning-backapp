import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Booking, INACTIVE_STATUSES } from "../models/booking.model";
import { Customer } from "../models/customer.model";
import { CustomerFollowUp, FOLLOW_UP_RESULTS } from "../models/customerFollowUp.model";
import { SessionUser } from "../types/AuthRequest";
import { addDays, isValidDate, todayStr } from "../utils/date";
import { yearParam } from "../utils/fortnight";
import { assertObjectId, str } from "../utils/http";
import { actor, branchFilter } from "../utils/scope";

/**
 * Gestión comercial (hojas REP ZONA, Frecuencia x Clientes, Clientes Potenciales Plan
 * Mensual y Gestión Comercial de Cartera). Todo cuenta servicios realizados o agendados
 * que no se cancelaron.
 */

export const NO_ZONE = "Sin zona";

function zoneOf(b: any): string {
  const z = typeof b?.zone === "string" ? b.zone.trim() : "";
  return z || NO_ZONE;
}

/** REP ZONA: servicios por zona y mes del año, con su %. */
export async function zoneReport(user: SessionUser, query: any) {
  const year = yearParam(query?.year);
  const scope = branchFilter(user, query?.branch);
  const bookings = await Booking.find({
    ...scope,
    date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` },
    status: { $nin: INACTIVE_STATUSES },
  })
    .select("date zone total")
    .lean();
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    total: 0,
    byZone: {} as Record<string, number>,
  }));
  const totals: Record<string, { count: number; amount: number }> = {};
  for (const b of bookings) {
    const z = zoneOf(b);
    const m = months[Number(b.date.slice(5, 7)) - 1];
    m.total++;
    m.byZone[z] = (m.byZone[z] ?? 0) + 1;
    totals[z] = totals[z] ?? { count: 0, amount: 0 };
    totals[z].count++;
    totals[z].amount += b.total;
  }
  const zones = Object.entries(totals)
    .map(([zone, t]) => ({ zone, ...t, share: bookings.length ? t.count / bookings.length : 0 }))
    .sort((a, b) => (a.zone === NO_ZONE ? 1 : b.zone === NO_ZONE ? -1 : b.count - a.count));
  return { year, total: bookings.length, zones, months };
}

/** Servicios por cliente en el rango (para frecuencia y potenciales). */
async function perCustomer(scope: Record<string, any>, from: string, to: string) {
  return Booking.aggregate<{ _id: Types.ObjectId; count: number; amount: number; last: string; first: string }>([
    { $match: { ...scope, date: { $gte: from, $lte: to }, status: { $nin: INACTIVE_STATUSES } } },
    {
      $group: {
        _id: "$customer",
        count: { $sum: 1 },
        amount: { $sum: "$total" },
        last: { $max: "$date" },
        first: { $min: "$date" },
      },
    },
  ]);
}

const BUCKETS = [
  { key: "one", label: "Una vez", min: 1, max: 1 },
  { key: "two_three", label: "Entre 2-3 veces", min: 2, max: 3 },
  { key: "four_five", label: "Entre 4-5 veces", min: 4, max: 5 },
  { key: "six_plus", label: "6 veces o más", min: 6, max: Infinity },
];

/** Frecuencia x Clientes + ranking de Clientes Potenciales para plan mensual. */
export async function frequencyReport(user: SessionUser, query: any) {
  const today = todayStr();
  const to = isValidDate(query?.to) ? query.to : today;
  const from = isValidDate(query?.from) ? query.from : addDays(to, -364);
  const scope = branchFilter(user, query?.branch);
  const rows = await perCustomer(scope, from, to);
  const totalCustomers = rows.length;
  const buckets = BUCKETS.map((b) => {
    const count = rows.filter((r) => r.count >= b.min && r.count <= b.max).length;
    return { key: b.key, label: b.label, customers: count, share: totalCustomers ? count / totalCustomers : 0 };
  });
  const top = rows.sort((a, b) => b.count - a.count || b.amount - a.amount).slice(0, 40);
  const customers = await Customer.find({ _id: { $in: top.map((r) => r._id) } })
    .select("name phone email")
    .lean();
  const cmap = new Map(customers.map((c) => [String(c._id), c]));
  return {
    from,
    to,
    totalCustomers,
    totalServices: rows.reduce((s, r) => s + r.count, 0),
    buckets,
    potential: top
      .filter((r) => r.count >= 2)
      .map((r) => {
        const c = cmap.get(String(r._id));
        return {
          customer: { _id: r._id, name: c?.name || "Sin nombre", phone: c?.phone ?? "", email: c?.email ?? "" },
          count: r.count,
          amount: r.amount,
          last: r.last,
          first: r.first,
        };
      }),
  };
}

/** Cartera: clientes cuyo último servicio fue hace más de N días (60 por defecto). */
export async function portfolio(user: SessionUser, query: any) {
  const today = todayStr();
  const days = Math.min(365, Math.max(15, Number(query?.days) || 60));
  const cutoff = addDays(today, -days);
  const scope = branchFilter(user, query?.branch);
  // Hasta el futuro: quien ya tiene un servicio agendado no está "sin servicio".
  const rows = await perCustomer(scope, "2000-01-01", "9999-12-31");
  const lapsed = rows.filter((r) => r.last < cutoff && r._id);
  const ids = lapsed.map((r) => r._id);
  const [customers, follow] = await Promise.all([
    Customer.find({ _id: { $in: ids } }).select("name phone email").lean(),
    CustomerFollowUp.find({ customer: { $in: ids } }).lean(),
  ]);
  const cmap = new Map(customers.map((c) => [String(c._id), c]));
  const fmap = new Map(follow.map((f) => [String(f.customer), f]));
  const result = String(query?.result ?? "");
  const items = lapsed
    .map((r) => {
      const c = cmap.get(String(r._id));
      const f = fmap.get(String(r._id));
      const since = Math.round(
        (new Date(`${today}T00:00:00Z`).getTime() - new Date(`${r.last}T00:00:00Z`).getTime()) / 86400000,
      );
      return {
        customer: { _id: r._id, name: c?.name || "Sin nombre", phone: c?.phone ?? "", email: c?.email ?? "" },
        lastService: r.last,
        daysSince: since,
        services: r.count,
        amount: r.amount,
        followUp: {
          contact1At: f?.contact1At ?? null,
          contact2At: f?.contact2At ?? null,
          contact3At: f?.contact3At ?? null,
          result: f?.result ?? "pending",
          notes: f?.notes ?? "",
          updatedAt: f?.updatedAt ?? null,
          updatedBy: f?.updatedBy?.name ?? "",
        },
      };
    })
    .filter((i) => !result || i.followUp.result === result)
    .sort((a, b) => a.daysSince - b.daysSince);
  const count = (r: string) => items.filter((i) => i.followUp.result === r).length;
  return {
    days,
    total: items.length,
    summary: {
      pending: count("pending"),
      accepted: count("accepted"),
      declined: count("declined"),
      unreachable: count("unreachable"),
      contacted: items.filter((i) => i.followUp.contact1At).length,
    },
    items,
  };
}

/** Marca/desmarca contactos (1, 2, 3), el resultado y las observaciones. */
export async function updateFollowUp(customerId: string, body: any, user: SessionUser) {
  assertObjectId(customerId, "el cliente");
  if (!(await Customer.exists({ _id: customerId }))) throw new CustomError("Cliente no encontrado", 404);
  const set: Record<string, any> = { updatedBy: actor(user) };
  for (const n of [1, 2, 3]) {
    const k = `contact${n}`;
    if (body?.[k] !== undefined) set[`${k}At`] = body[k] ? new Date() : null;
  }
  if (body?.result !== undefined) {
    if (!(FOLLOW_UP_RESULTS as readonly string[]).includes(String(body.result)))
      throw new CustomError("Resultado inválido", 400);
    set.result = body.result;
  }
  if (body?.notes !== undefined) set.notes = str(body.notes, 500);
  const doc = await CustomerFollowUp.findOneAndUpdate(
    { customer: customerId },
    { $set: set, $setOnInsert: { customer: customerId } },
    { upsert: true, new: true },
  ).lean();
  return { ...doc, updatedBy: doc?.updatedBy?.name ?? "" };
}
