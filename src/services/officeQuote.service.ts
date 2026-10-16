import { isValidObjectId, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Branch } from "../models/branch.model";
import { nextCode } from "../models/counter.model";
import { OfficeQuote, QUOTE_PLANS, QUOTE_STATUSES } from "../models/officeQuote.model";
import { ISettings } from "../models/setting.model";
import { SessionUser } from "../types/AuthRequest";
import {
  EMAIL_RE,
  assertObjectId,
  escapeRegex,
  formatMoney,
  paginated,
  parsePage,
  str,
} from "../utils/http";
import { tierMinQty, tierUnitPrice } from "../utils/tiers";
import { assertBranchAccess } from "../utils/scope";
import { sendOfficeQuote } from "./bookingEmail.service";
import { createBooking, getAdminBooking } from "./booking.service";
import { getSettings } from "./settings.service";

const PLAN_LABEL: Record<string, string> = {
  basico: "Básico",
  profundo: "Profundo",
  mensual: "Plan mensual",
};

function count(value: unknown, label: string, max: number, decimals = false): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  const ok = decimals ? Number.isFinite(n) : Number.isInteger(n);
  if (!ok || n < 0 || n > max) throw new CustomError(`${label} inválido`, 400);
  return decimals ? Math.round(n * 100) / 100 : n;
}

export interface OfficeInput {
  squareMeters: number;
  plan: string;
  chairsFabric: number;
  chairsMixed: number;
  windows: number;
  bathrooms: number;
}

/**
 * Fórmula real del catálogo (el front la replica igual en `composables/office/officePricing.ts`):
 * m² × tarifa del plan (Básico / Profundo) + sillas de tela y mixtas por unidad + ventanales y
 * sanitarios por tramos (el precio del tramo alcanzado aplica a todas las unidades).
 * Plan mensual = tarifa especial: sin estimado (null) y sin desglose; el equipo contacta.
 */
export function computeEstimate(input: OfficeInput, pricing: ISettings["officePricing"]) {
  if (input.plan === "mensual") return { estimate: null, breakdown: [] };
  const breakdown: { label: string; amount: number }[] = [];
  const add = (label: string, amount: number) =>
    amount > 0 && breakdown.push({ label, amount: Math.round(amount) });
  const perM2 = input.plan === "profundo" ? pricing.deepPerM2 : pricing.basicPerM2;
  add(
    `Limpieza ${PLAN_LABEL[input.plan]}: ${input.squareMeters} m² × ${formatMoney(perM2)}`,
    input.squareMeters * perM2,
  );
  add(
    `Sillas de tela: ${input.chairsFabric} × ${formatMoney(pricing.chairFabric)}`,
    input.chairsFabric * pricing.chairFabric,
  );
  add(
    `Sillas mixtas: ${input.chairsMixed} × ${formatMoney(pricing.chairMixed)}`,
    input.chairsMixed * pricing.chairMixed,
  );
  if (input.windows > 0) {
    const unit = tierUnitPrice(pricing.windowTiers, input.windows) ?? 0;
    add(`Ventanales: ${input.windows} × ${formatMoney(unit)}`, input.windows * unit);
  }
  if (input.bathrooms > 0) {
    const unit = tierUnitPrice(pricing.bathroomTiers, input.bathrooms) ?? 0;
    add(`Desinfección de sanitarios: ${input.bathrooms} × ${formatMoney(unit)}`, input.bathrooms * unit);
  }
  return { estimate: breakdown.reduce((s, r) => s + r.amount, 0), breakdown };
}

function parseInput(body: any, pricing: ISettings["officePricing"]): OfficeInput {
  const plan = String(body?.plan ?? "basico");
  if (!(QUOTE_PLANS as readonly string[]).includes(plan))
    throw new CustomError("Elige un plan: Básico, Profundo o Plan mensual", 400);
  const input = {
    squareMeters: count(body?.squareMeters, "El área en m²", 100000, true),
    plan,
    chairsFabric: count(body?.chairsFabric, "El número de sillas de tela", 10000),
    chairsMixed: count(body?.chairsMixed, "El número de sillas mixtas", 10000),
    windows: count(body?.windows, "El número de ventanales", 10000),
    bathrooms: count(body?.bathrooms, "El número de baños", 1000),
  };
  const minWindows = tierMinQty(pricing.windowTiers);
  if (input.windows > 0 && input.windows < minWindows) {
    throw new CustomError(`La limpieza de ventanales es desde ${minWindows} unidades`, 400);
  }
  return input;
}

export async function createOfficeQuote(body: any) {
  const contact = {
    name: str(body?.contact?.name, 160),
    email: str(body?.contact?.email, 200).toLowerCase(),
    phone: str(body?.contact?.phone, 30),
    company: str(body?.contact?.company, 160),
  };
  if (!contact.name) throw new CustomError("Escribe tu nombre", 400);
  if (contact.email && !EMAIL_RE.test(contact.email))
    throw new CustomError("El correo no es válido", 400);
  if (!contact.email && !contact.phone) throw new CustomError("Escribe tu correo o teléfono", 400);
  let branch: string | null = null;
  if (body?.branch) {
    branch = assertObjectId(body.branch, "la sucursal");
    if (!(await Branch.exists({ _id: branch, active: true })))
      throw new CustomError("Sucursal no encontrada", 404);
  }
  const settings = await getSettings();
  const input = parseInput(body, settings.officePricing);
  if (!input.squareMeters) throw new CustomError("Indica los m² de la oficina", 400);
  const { estimate, breakdown } = computeEstimate(input, settings.officePricing);
  const quote = await OfficeQuote.create({
    code: await nextCode("officeQuote", "COT"),
    branch,
    contact,
    ...input,
    notes: str(body?.notes, 2000),
    estimate,
    breakdown,
  });
  const obj = quote.toObject();
  await sendOfficeQuote(obj);
  return obj;
}

function scope(user: SessionUser): Record<string, any> {
  if (user.role === "admin") return {};
  // Las cotizaciones sin sucursal las ve cualquier manager: alguien tiene que atenderlas.
  return { branch: { $in: [null, ...user.branches.map((b) => new Types.ObjectId(b))] } };
}

export async function listOfficeQuotes(user: SessionUser, query: any) {
  const { page, limit, skip } = parsePage(query);
  const filter: Record<string, any> = scope(user);
  if (query?.status) filter.status = { $in: String(query.status).split(",") };
  if (query?.branch && isValidObjectId(String(query.branch))) {
    assertBranchAccess(user, String(query.branch));
    filter.branch = new Types.ObjectId(String(query.branch));
  }
  if (query?.q) {
    const re = new RegExp(escapeRegex(str(query.q, 80)), "i");
    filter.$or = [
      { code: re },
      { "contact.name": re },
      { "contact.email": re },
      { "contact.phone": re },
      { "contact.company": re },
    ];
  }
  const [items, total] = await Promise.all([
    OfficeQuote.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    OfficeQuote.countDocuments(filter),
  ]);
  return paginated(items, total, page, limit);
}

async function loadScoped(id: string, user: SessionUser) {
  assertObjectId(id, "la cotización");
  const quote = await OfficeQuote.findById(id);
  if (!quote) throw new CustomError("Cotización no encontrada", 404);
  if (quote.branch) assertBranchAccess(user, quote.branch);
  return quote;
}

export async function getOfficeQuote(id: string, user: SessionUser) {
  return (await loadScoped(id, user)).toObject();
}

export async function updateOfficeQuote(id: string, body: any, user: SessionUser) {
  const quote = await loadScoped(id, user);
  if (body?.status !== undefined) {
    if (!(QUOTE_STATUSES as readonly string[]).includes(String(body.status)))
      throw new CustomError("Estado inválido", 400);
    quote.status = body.status;
  }
  if (body?.notes !== undefined) quote.notes = str(body.notes, 2000);
  if (body?.branch !== undefined) {
    if (!body.branch) quote.branch = null;
    else {
      const b = assertObjectId(body.branch, "la sucursal");
      assertBranchAccess(user, b);
      quote.branch = new Types.ObjectId(b);
    }
  }
  const fields = ["squareMeters", "plan", "chairsFabric", "chairsMixed", "windows", "bathrooms"];
  if (fields.some((k) => body?.[k] !== undefined)) {
    const pricing = (await getSettings()).officePricing;
    const merged: any = {};
    for (const k of fields) merged[k] = body[k] ?? (quote as any)[k];
    const input = parseInput(merged, pricing);
    Object.assign(quote, input, computeEstimate(input, pricing));
  }
  // Ajuste manual del valor final (negociado con el cliente).
  if (body?.estimate !== undefined) {
    const n = Number(body.estimate);
    if (!Number.isInteger(n) || n < 0)
      throw new CustomError("El estimado debe ser un entero en centavos", 400);
    quote.estimate = n;
  }
  await quote.save();
  return quote.toObject();
}

/**
 * POST /admin/office-quotes/:id/convert — crea el pedido con una línea libre por
 * el valor cotizado. Body: { date, time, branch?, address?, paymentMethod?, operators?, notes?, status? }.
 */
export async function convertOfficeQuote(id: string, body: any, user: SessionUser) {
  const quote = await loadScoped(id, user);
  if (quote.booking) throw new CustomError("Esta cotización ya tiene una reserva", 409);
  if (quote.estimate === null || quote.estimate === undefined) {
    throw new CustomError("Define primero el valor acordado (plan mensual: tarifa especial)", 409);
  }
  let branch = body?.branch ?? (quote.branch ? String(quote.branch) : undefined);
  if (!branch) {
    // Cotización sin sucursal: la primera sucursal activa a la que el usuario tiene acceso.
    const candidates = await Branch.find({
      active: true,
      ...(user.role === "admin" ? {} : { _id: { $in: user.branches } }),
    })
      .sort({ name: 1 })
      .select("_id")
      .lean();
    if (!candidates.length) throw new CustomError("Elige la sucursal de la reserva", 400);
    branch = String(candidates[0]._id);
  }
  const plan = ` · ${PLAN_LABEL[quote.plan] ?? quote.plan}`;
  const { bookingId } = await createBooking(
    {
      branch,
      items: [
        {
          name: `Limpieza de oficina (${quote.code}${plan})`,
          unitPrice: quote.estimate,
          quantity: 1,
        },
      ],
      date: body?.date,
      time: body?.time,
      customer: {
        name: quote.contact.name,
        email: quote.contact.email,
        phone: quote.contact.phone,
      },
      address: body?.address,
      reference: body?.reference ?? quote.contact.company,
      notes: body?.notes ?? quote.notes,
      paymentMethod: body?.paymentMethod ?? "transfer",
      operators: body?.operators,
      status: body?.status ?? "confirmed",
      invoice: body?.invoice,
    },
    { source: "admin", user, officeQuoteId: quote._id as Types.ObjectId },
  );
  quote.booking = bookingId as Types.ObjectId;
  quote.status = "won";
  await quote.save();
  return getAdminBooking(String(bookingId), user);
}
