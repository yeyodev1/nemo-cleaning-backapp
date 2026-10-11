import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import mongoose, { Types } from "mongoose";
import { dbConnect } from "../config/mongo";
import { Booking, PaymentConfirmation } from "../models/booking.model";
import { Branch } from "../models/branch.model";
import { Customer } from "../models/customer.model";
import { Payment } from "../models/payment.model";
import { Service } from "../models/service.model";
import { User } from "../models/user.model";
import { toDateTime } from "../utils/date";

/**
 * Importa la producción histórica del Excel ("Base Samborondon", ya limpiada en JSON) a la BD.
 *
 *   ts-node-dev --transpile-only src/scripts/import-history.ts --dir <carpeta> [--dry-run]
 *   ts-node-dev --transpile-only src/scripts/import-history.ts --rollback [--dry-run]
 *
 * La carpeta trae `clean.json` (filas; se saltan las que tienen `duplicateOf`), `operators.json`
 * y `clients.json`. Todo lo creado lleva `importBatch` para poder deshacerlo con `--rollback`.
 *
 * Reglas (decididas por gerencia):
 * - Todo va a la sucursal samborondon (los reportes cuentan ahí también la zona "Vía a la Costa").
 * - Un pedido `completed`, `source: "import"`, por fila; código propio HIS-000001… en orden
 *   cronológico, sin tocar el contador `booking` (el próximo pedido real sigue siendo NEMO-000001).
 * - El dinero sale del total de la fila; las líneas siempre suman ese total.
 * - Efectivo y transferencias con cuenta: Payment `approved` (paidAt = fecha del servicio). Una
 *   transferencia "pendiente de confirmación" desde 2026-08-01 queda así, con su Payment en `review`
 *   (los "valores por confirmar" de gerencia); antes de esa fecha ya está conciliada → confirmado.
 * - Sin pago: perdida, pendiente de pago, canje, cortesía, plan mensual y formas de pago vacías.
 * Usa insertMany directo: no corre hooks, no manda correos ni webhooks.
 * Idempotente: lo que ya existe en el lote (mismo nombre / mismo código) no se vuelve a crear.
 */

const BATCH = "excel-2026-10";
const CHUNK = 1000;
const CUTOFF = "2026-08-01";
const ACTIVE_SINCE = "2026-09-06";
const DEFAULT_TIME = "09:00";
const ACTOR = { id: "import", name: "Importación Excel" };

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ROLLBACK = args.includes("--rollback");
const dirArg = args.indexOf("--dir");
const DIR = dirArg >= 0 ? args[dirArg + 1] : "";

// ---------------------------------------------------------------------------
// Tipos de la entrada (clean.json, operators.json, clients.json). Dinero en centavos.
// ---------------------------------------------------------------------------

interface RawService {
  raw: string;
  slug: string | null;
  variant: string;
  name: string;
}

interface RawRecord {
  branch: string;
  date: string;
  time?: string | null;
  operator: string | null;
  client: string;
  clientKey: string;
  zone: string | null;
  services: RawService[];
  servicesRaw: string | null;
  total: number | null;
  puntos: number | null;
  paymentMethod: string | null;
  paymentAccount: string | null;
  paymentRaw: string | null;
  reference: string | null;
  confirmation: string | null;
  confirmationNote: string | null;
  confirmationRaw: string | null;
  tip: number | null;
  notes: string | null;
  source: { sheet: string; row: number };
  duplicateOf?: unknown;
  identicalTo?: unknown;
}

interface RawOperator {
  name: string;
  lastDate: string;
  isPerson: boolean;
}

interface RawClient {
  key: string;
  name: string;
  phone: string | null;
}

// ---------------------------------------------------------------------------
// Personal: nombres, cargos y sueldos vienen de `payroll.json` en la carpeta del historial
// (fuera del repo: son datos privados del cliente). Formato:
// { "supervisor": "Nombre", "payroll": { "<operador canónico>": { "name", "position", "salary" (centavos) } } }
// ---------------------------------------------------------------------------

type Position = "supervisor" | "base_assistant" | "washer" | "";

let PAYROLL: Record<string, { name: string; position: Position; salary: number }> = {};
let SUPERVISOR_NAME = "Supervisor";
const PSEUDO_OPERATOR = "VIA LA COSTA (equipo)";
const PSEUDO_NAME = "Vía a la Costa (histórico)";

/** Colores distintos repartidos en el círculo cromático (ángulo áureo). */
function colorFor(i: number): string {
  const h = (i * 137.508) % 360;
  const s = 0.62;
  const l = i % 2 ? 0.42 : 0.5;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Forma de pago y confirmación
// ---------------------------------------------------------------------------

const BANK_LABEL: Record<string, string> = {
  guayaquil: "Transferencia Guayaquil",
  pichincha: "Transferencia Pichincha",
  pacifico: "Transferencia Pacífico",
  produbanco: "Transferencia Produbanco",
  "bolivariano-ou": "Transferencia Bolivariano (OU)",
  "pichincha-ou": "Transferencia Pichincha (OU)",
  "pacifico-ou": "Transferencia Pacífico (OU)",
  "guayaquil-ou": "Transferencia Guayaquil (OU)",
};

interface PaymentPlan {
  account: string;
  method: "cash" | "transfer" | null;
  confirmation: PaymentConfirmation;
  /** Estado del Payment a crear; null = sin pago (queda por cobrar, o no se cobra). */
  payment: "approved" | "review" | null;
  note: string;
}

function planPayment(r: RawRecord): PaymentPlan {
  const m = r.paymentMethod;
  const conf = r.confirmation;
  const old = r.date < CUTOFF;
  // Confirmación para un pago con dinero (efectivo / transferencia).
  const paid = (account: string, method: "cash" | "transfer"): PaymentPlan => {
    if (conf === "pendiente de pago")
      return { account, method, confirmation: "pending_payment", payment: null, note: "" };
    if (conf === "confirmado") return { account, method, confirmation: "confirmed", payment: "approved", note: "" };
    if (conf === "plan mensual" || conf === "otro")
      return { account, method, confirmation: "confirmed", payment: "approved", note: `Confirmación original: ${r.confirmationRaw ?? conf}` };
    // "pendiente de confirmación" o vacía.
    if (old) return { account, method, confirmation: "confirmed", payment: "approved", note: "" };
    return { account, method, confirmation: "pending_confirmation", payment: "review", note: "" };
  };
  const unpaid = (account: string, confirmation: PaymentConfirmation, note = ""): PaymentPlan => ({
    account,
    method: null,
    confirmation,
    payment: null,
    note,
  });
  // Sin pago: la confirmación del Excel se conserva (pendiente antigua → confirmado, por la regla).
  const keep = (): PaymentConfirmation => {
    if (conf === "pendiente de pago") return "pending_payment";
    if (conf === "confirmado") return "confirmed";
    if (conf === "pendiente de confirmación") return old ? "confirmed" : "pending_confirmation";
    return "pending_payment";
  };

  switch (m) {
    case "efectivo":
      return paid("Efectivo", "cash");
    case "transferencia": {
      // "Transferencia Pendiente": sin banco no hay dónde registrar el pago; queda por cobrar.
      if (!r.paymentAccount) return unpaid(r.paymentRaw || "Transferencia sin cuenta", keep());
      return paid(BANK_LABEL[r.paymentAccount] ?? `Transferencia ${r.paymentAccount}`, "transfer");
    }
    case "perdida":
      return unpaid("", "lost");
    case "canje":
      return unpaid("Canje", "exchange");
    case "cortesia":
      // El modelo agrupa canje y cortesía como "sin cobro".
      return unpaid("Cortesía", "exchange");
    case "plan_mensual":
      return unpaid("Plan mensual", keep());
    case "adelanto_utilidades":
      return unpaid("Adelanto utilidades", keep());
    case "gestion_cobro_especial":
      return unpaid("Gestión de cobro especial", keep());
    default:
      return unpaid("", "pending_payment", "Sin forma de pago en el Excel");
  }
}

// ---------------------------------------------------------------------------
// Líneas del pedido
// ---------------------------------------------------------------------------

type ServiceDoc = {
  _id: Types.ObjectId;
  name: string;
  price: number;
  unit: string;
  isExtra: boolean;
  variants: { label: string; price: number }[];
};

function buildItems(r: RawRecord, catalog: Map<string, ServiceDoc>, total: number, warn: (w: string) => void) {
  const lines = (r.services.length ? r.services : [{ raw: r.servicesRaw ?? "Servicio", slug: null, variant: "", name: r.servicesRaw || "Servicio" }]).map((s) => {
    const svc = s.slug ? catalog.get(s.slug) : undefined;
    if (s.slug && !svc) warn(`servicio sin catálogo: ${s.slug}`);
    let variant = s.variant || "";
    let price = 0;
    if (svc) {
      const v = variant ? svc.variants.find((x) => x.label === variant) : undefined;
      if (variant && !v) {
        warn(`variante inexistente ${s.slug}:${variant}`);
        variant = "";
      }
      price = v ? v.price : svc.variants.length ? 0 : svc.price;
    }
    return {
      service: svc ? svc._id : null,
      name: svc ? svc.name : s.name || s.raw,
      variant,
      unit: svc ? svc.unit : "servicio",
      isExtra: svc ? svc.isExtra : false,
      price,
    };
  });

  // Las líneas 2..n con precio de catálogo lo conservan; el resto del total va a la primera
  // y a las que no tienen precio. Si no alcanza, se reparte proporcional. Siempre suma el total.
  const amounts = new Array(lines.length).fill(0);
  if (lines.length === 1) amounts[0] = total;
  else {
    const fixedIdx = lines.map((l, i) => (i > 0 && l.price > 0 ? i : -1)).filter((i) => i >= 0);
    const fixedSum = fixedIdx.reduce((s, i) => s + lines[i].price, 0);
    if (fixedSum <= total) {
      for (const i of fixedIdx) amounts[i] = lines[i].price;
      const open = lines.map((_, i) => i).filter((i) => !fixedIdx.includes(i));
      const rest = total - fixedSum;
      const each = Math.floor(rest / open.length);
      for (const i of open) amounts[i] = each;
      amounts[open[0]] += rest - each * open.length;
    } else {
      const weights = lines.map((l) => l.price || 1);
      const wsum = weights.reduce((a, b) => a + b, 0);
      let acc = 0;
      for (let i = 1; i < lines.length; i++) {
        amounts[i] = Math.floor((total * weights[i]) / wsum);
        acc += amounts[i];
      }
      amounts[0] = total - acc;
    }
  }
  return lines.map((l, i) => ({
    service: l.service,
    name: l.name,
    variant: l.variant,
    unitPrice: amounts[i],
    unitPriceMax: 0,
    unit: l.unit,
    quantity: 1,
    subtotal: amounts[i],
    isExtra: l.isExtra,
  }));
}

// ---------------------------------------------------------------------------

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")) as T;
}

const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function chunked<T>(docs: T[], fn: (part: T[]) => Promise<unknown>) {
  for (let i = 0; i < docs.length; i += CHUNK) {
    await fn(docs.slice(i, i + CHUNK));
    process.stdout.write(`  ${Math.min(i + CHUNK, docs.length)}/${docs.length}\r`);
  }
  if (docs.length) process.stdout.write("\n");
}

async function rollback() {
  const filter = { importBatch: BATCH };
  const counts = {
    bookings: await Booking.countDocuments(filter),
    payments: await Payment.countDocuments(filter),
    customers: await Customer.countDocuments(filter),
    users: await User.countDocuments(filter),
  };
  console.log(`Rollback del lote ${BATCH}${DRY ? " (simulación)" : ""}:`, counts);
  if (DRY) return;
  // Pagos y pedidos primero; los clientes y usuarios solo si los creó el lote.
  await Payment.deleteMany(filter);
  await Booking.deleteMany(filter);
  await Customer.deleteMany(filter);
  await User.deleteMany({ ...filter, email: { $in: ["", null] } });
  console.log("Listo.");
}

async function main() {
  if (!(await dbConnect())) throw new Error("No se pudo conectar a Mongo");
  if (ROLLBACK) return rollback();
  if (!DIR) throw new Error("Falta --dir <carpeta con clean.json>");

  const warnings = new Map<string, number>();
  const warn = (w: string) => warnings.set(w, (warnings.get(w) ?? 0) + 1);

  const records = readJson<RawRecord[]>("clean.json").filter((r) => !r.duplicateOf);
  if (fs.existsSync(path.join(DIR, "payroll.json"))) {
    const payroll = readJson<{ supervisor?: string; payroll?: typeof PAYROLL }>("payroll.json");
    PAYROLL = payroll.payroll ?? {};
    if (payroll.supervisor) SUPERVISOR_NAME = payroll.supervisor;
  }
  const operators = readJson<{ operators: RawOperator[] }>("operators.json").operators;
  const clients = readJson<{ clients: RawClient[] }>("clients.json").clients;
  console.log(`Filas a importar: ${records.length}${DRY ? " (simulación, no escribe nada)" : ""}`);

  const branch = await Branch.findOne({ slug: "samborondon" }).lean();
  if (!branch) throw new Error("No existe la sucursal samborondon");
  const branchId = branch._id as Types.ObjectId;
  const catalog = new Map(
    (await Service.find({}).select("name slug price unit isExtra variants").lean()).map((s: any) => [s.slug, s as ServiceDoc]),
  );

  // ---- Personal ---------------------------------------------------------
  const existingUsers = new Map(
    (await User.find({ importBatch: BATCH }).select("name").lean()).map((u) => [u.name, u._id as Types.ObjectId]),
  );
  const newUsers: any[] = [];
  const userFor = (name: string, doc: Record<string, unknown>) => {
    const id = existingUsers.get(name) ?? new Types.ObjectId();
    if (!existingUsers.has(name)) newUsers.push({ _id: id, name, ...doc });
    return id;
  };
  const baseUser = { email: "", phone: "", role: "operator", branches: [branchId], importBatch: BATCH, commissions: true };
  const juanId = userFor(SUPERVISOR_NAME, {
    ...baseUser,
    active: true,
    color: colorFor(0),
    position: "supervisor",
    monthlySalary: 60000,
    // El supervisor no produce: cobra el "FEE supervisor" de los demás, no un FEE propio.
    commissions: false,
    supervisor: null,
  });
  const operatorId = new Map<string, Types.ObjectId>();
  const summaryUsers: { name: string; active: boolean; position: string }[] = [{ name: SUPERVISOR_NAME, active: true, position: "supervisor" }];
  operators.forEach((o, i) => {
    const pseudo = o.name === PSEUDO_OPERATOR || !o.isPerson;
    const pay = PAYROLL[o.name];
    const name = pseudo ? PSEUDO_NAME : (pay?.name ?? o.name);
    const active = !pseudo && o.lastDate >= ACTIVE_SINCE;
    const position = pseudo ? "" : (pay?.position ?? "washer");
    operatorId.set(
      o.name,
      userFor(name, {
        ...baseUser,
        active,
        color: colorFor(i + 1),
        position,
        monthlySalary: pay?.salary ?? 0,
        commissions: !pseudo,
        supervisor: pseudo ? null : juanId,
      }),
    );
    summaryUsers.push({ name, active, position });
  });

  // ---- Clientes ---------------------------------------------------------
  const existingCustomers = new Map(
    (await Customer.find({ importBatch: BATCH }).select("name").lean()).map((c) => [c.name, c._id as Types.ObjectId]),
  );
  const clientByKey = new Map(clients.map((c) => [c.key, c]));
  const customerId = new Map<string, Types.ObjectId>();
  const customerAgg = new Map<string, { orders: number; spent: number; first: string }>();
  const newCustomers: any[] = [];

  // ---- Pedidos y pagos ---------------------------------------------------
  const sorted = [...records].sort(
    (a, b) => a.date.localeCompare(b.date) || a.source.sheet.localeCompare(b.source.sheet) || a.source.row - b.source.row,
  );
  const existingCodes = new Set(
    (await Booking.find({ importBatch: BATCH }).select("code").lean()).map((b) => b.code),
  );
  const bookings: any[] = [];
  const payments: any[] = [];
  const totals = { production: 0, approved: 0, review: 0, tips: 0, noPayment: 0 };
  const byMonth = new Map<string, { count: number; total: number }>();
  const byConfirmation = new Map<string, number>();

  sorted.forEach((r, idx) => {
    const code = `HIS-${String(idx + 1).padStart(6, "0")}`;
    const client = clientByKey.get(r.clientKey);
    if (!client) warn(`cliente sin ficha: ${r.clientKey}`);
    const cname = client?.name ?? r.client;
    let cid = customerId.get(r.clientKey);
    if (!cid) {
      cid = existingCustomers.get(cname) ?? new Types.ObjectId();
      customerId.set(r.clientKey, cid);
      if (!existingCustomers.has(cname))
        newCustomers.push({
          _id: cid,
          name: cname,
          email: "",
          phone: client?.phone ?? "",
          branch: branchId,
          notes: "Cliente del Excel histórico de producción.",
          importBatch: BATCH,
        });
    }

    const total = r.total ?? 0;
    const time = r.time && /^\d{2}:\d{2}$/.test(r.time) ? r.time : DEFAULT_TIME;
    const startAt = toDateTime(r.date, time);
    const plan = planPayment(r);
    const items = buildItems(r, catalog, total, warn);
    const ops: Types.ObjectId[] = [];
    if (r.operator) {
      const op = operatorId.get(r.operator);
      if (op) ops.push(op);
      else warn(`operador sin usuario: ${r.operator}`);
    }

    const notes = [
      r.notes,
      r.total === null ? "Total vacío en el Excel" : "",
      plan.note,
      r.confirmationNote,
      !plan.payment && r.reference ? `Comprobante: ${r.reference}` : "",
      r.puntos ? `Puntos: ${r.puntos}` : "",
      r.paymentRaw && !plan.method && !["PERDIDA", "Canje", "Plan Mensual"].includes(r.paymentRaw) ? `Pago en el Excel: ${r.paymentRaw}` : "",
      r.services.some((s) => !s.slug) && r.servicesRaw ? `Servicio en el Excel: ${r.servicesRaw}` : "",
      `Excel: ${r.source.sheet} fila ${r.source.row}`,
    ]
      .filter(Boolean)
      .join(" | ");

    const willPay = plan.payment && plan.method && total > 0;
    const approved = willPay && plan.payment === "approved";
    const bid = new Types.ObjectId();
    const isNew = !existingCodes.has(code);
    if (isNew)
      bookings.push({
        _id: bid,
        code,
        accessToken: crypto.randomBytes(24).toString("hex"),
        branch: branchId,
        customer: cid,
        source: "import",
        items,
        subtotal: total,
        discount: 0,
        total,
        date: r.date,
        time,
        startAt,
        durationMinutes: 60,
        address: "",
        reference: "",
        notes,
        status: "completed",
        operators: ops,
        paymentMethod: plan.method ?? "cash",
        paymentStatus: approved ? "paid" : willPay ? "review" : "pending",
        amountPaid: approved ? total : 0,
        balance: approved ? 0 : total,
        zone: r.zone ?? "",
        tip: r.tip && r.tip > 0 ? r.tip : 0,
        paymentAccount: plan.account,
        paymentConfirmation: plan.confirmation,
        novedades: [],
        history: [{ at: startAt, by: ACTOR.name, action: "created", note: "Importado del Excel histórico de producción" }],
        importBatch: BATCH,
        createdAt: startAt,
        updatedAt: startAt,
      });
    if (isNew && willPay)
      payments.push({
        booking: bid,
        bookingCode: code,
        branch: branchId,
        customer: cid,
        // La propina no es producción: el pago cubre el total del servicio.
        amount: total,
        method: plan.method,
        provider: "manual",
        status: plan.payment,
        proofUrl: "",
        reference: r.reference ?? "",
        clientTransactionId: `IMPORT-${code}`,
        transactionId: "",
        account: plan.account,
        note: "Importado del Excel histórico",
        registeredBy: ACTOR,
        ...(approved ? { reviewedBy: ACTOR, reviewedAt: startAt, paidAt: startAt } : {}),
        verifiedAt: null,
        verifiedBy: null,
        importBatch: BATCH,
        createdAt: startAt,
        updatedAt: startAt,
      });

    totals.production += total;
    totals.tips += r.tip && r.tip > 0 ? r.tip : 0;
    if (approved) totals.approved += total;
    else if (willPay) totals.review += total;
    else totals.noPayment += total;
    const mk = r.date.slice(0, 7);
    const m = byMonth.get(mk) ?? { count: 0, total: 0 };
    m.count++;
    m.total += total;
    byMonth.set(mk, m);
    byConfirmation.set(plan.confirmation, (byConfirmation.get(plan.confirmation) ?? 0) + 1);
    const ca = customerAgg.get(String(cid)) ?? { orders: 0, spent: 0, first: r.date };
    ca.orders++;
    if (approved) ca.spent += total;
    customerAgg.set(String(cid), ca);
  });

  // Fecha de alta del cliente = su primer servicio (el listado ordena por createdAt).
  for (const c of newCustomers) {
    const a = customerAgg.get(String(c._id));
    c.totalOrders = a?.orders ?? 0;
    c.totalSpent = a?.spent ?? 0;
    c.createdAt = a ? toDateTime(a.first, DEFAULT_TIME) : new Date();
    c.updatedAt = c.createdAt;
  }

  // ---- Resumen -----------------------------------------------------------
  console.log(`\nPersonal (${summaryUsers.length}; nuevos ${newUsers.length}): activos ${summaryUsers.filter((u) => u.active).length}, inactivos ${summaryUsers.filter((u) => !u.active).length}`);
  for (const u of summaryUsers) console.log(`  ${u.active ? "●" : "○"} ${u.name}${u.position ? ` (${u.position})` : ""}`);
  console.log(`Clientes: ${customerId.size} (nuevos ${newCustomers.length})`);
  console.log(`Pedidos: ${sorted.length} (nuevos ${bookings.length}) · ${sorted[0]?.date} → ${sorted.at(-1)?.date}`);
  console.log(`Pagos nuevos: ${payments.length} (aprobados ${payments.filter((p) => p.status === "approved").length}, en revisión ${payments.filter((p) => p.status === "review").length})`);
  console.log(`Producción ${money(totals.production)} · aprobado ${money(totals.approved)} · por confirmar ${money(totals.review)} · sin pago ${money(totals.noPayment)} · propinas ${money(totals.tips)}`);
  console.log("Confirmación:", Object.fromEntries(byConfirmation));
  console.log("Por mes:");
  for (const [k, v] of [...byMonth.entries()].sort()) console.log(`  ${k}  ${String(v.count).padStart(4)}  ${money(v.total)}`);
  const q1 = (month: string) => sorted.filter((r) => r.date.startsWith(month) && Number(r.date.slice(8, 10)) <= 15).reduce((s, r) => s + (r.total ?? 0), 0);
  console.log(`Ago 2026 Q1 ${money(q1("2026-08"))} · Sep 2026 Q1 ${money(q1("2026-09"))}`);
  const itemMismatch = bookings.filter((b) => b.items.reduce((s: number, i: any) => s + i.subtotal, 0) !== b.total).length;
  console.log(`Pedidos cuyas líneas no suman el total: ${itemMismatch}`);
  if (warnings.size) console.log("Avisos:", Object.fromEntries(warnings));

  if (DRY) return;

  // ---- Escritura ----------------------------------------------------------
  await Promise.all([Booking.createIndexes(), Payment.createIndexes(), Customer.createIndexes()]);
  console.log("\nInsertando personal…");
  if (newUsers.length) await User.insertMany(newUsers, { ordered: true });
  console.log("Insertando clientes…");
  await chunked(newCustomers, (p) => Customer.insertMany(p, { ordered: true }));
  console.log("Insertando pedidos…");
  await chunked(bookings, (p) => Booking.insertMany(p, { ordered: true }));
  console.log("Insertando pagos…");
  await chunked(payments, (p) => Payment.insertMany(p, { ordered: true }));

  // Totales del cliente desde lo que quedó en la BD (corrige corridas parciales).
  const [orders, spent] = await Promise.all([
    Booking.aggregate([{ $match: { importBatch: BATCH } }, { $group: { _id: "$customer", n: { $sum: 1 } } }]),
    Payment.aggregate([{ $match: { importBatch: BATCH, status: "approved" } }, { $group: { _id: "$customer", t: { $sum: "$amount" } } }]),
  ]);
  const spentMap = new Map(spent.map((s) => [String(s._id), s.t]));
  await chunked(orders, (p) =>
    Customer.bulkWrite(
      p.map((o: any) => ({
        updateOne: { filter: { _id: o._id, importBatch: BATCH }, update: { $set: { totalOrders: o.n, totalSpent: spentMap.get(String(o._id)) ?? 0 } } },
      })),
    ),
  );
  console.log("Importación terminada.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
