import { CustomError } from "../errors/customError.error";
import { SERVICE_CATEGORIES, SERVICE_UNITS, Service } from "../models/service.model";
import { assertObjectId, cents, slugify, str } from "../utils/http";

const SORT = { order: 1, name: 1 } as const;

export async function listPublicServices(query: any) {
  const filter: Record<string, any> = { active: true };
  if (
    query?.category &&
    (SERVICE_CATEGORIES as readonly string[]).includes(String(query.category))
  ) {
    filter.category = String(query.category);
  }
  return Service.find(filter).sort(SORT).lean();
}

export async function listServices(query: any) {
  const filter: Record<string, any> = {};
  if (query?.category) filter.category = String(query.category);
  if (query?.active === "true") filter.active = true;
  if (query?.active === "false") filter.active = false;
  return Service.find(filter).sort(SORT).lean();
}

export async function getService(id: string) {
  assertObjectId(id, "el servicio");
  const s = await Service.findById(id).lean();
  if (!s) throw new CustomError("Servicio no encontrado", 404);
  return s;
}

function applyFields(target: any, body: any) {
  if (body?.name !== undefined) target.name = str(body.name, 120);
  if (body?.description !== undefined) target.description = str(body.description, 1000);
  if (body?.imageUrl !== undefined) target.imageUrl = str(body.imageUrl, 500);
  if (body?.price !== undefined) target.price = cents(body.price, "El precio");
  if (body?.category !== undefined) {
    if (!(SERVICE_CATEGORIES as readonly string[]).includes(String(body.category))) {
      throw new CustomError("Categoría inválida", 400);
    }
    target.category = String(body.category);
  }
  if (body?.unit !== undefined) {
    if (!(SERVICE_UNITS as readonly string[]).includes(String(body.unit)))
      throw new CustomError("Unidad inválida", 400);
    target.unit = String(body.unit);
  }
  if (body?.durationMinutes !== undefined) {
    const n = Number(body.durationMinutes);
    if (!Number.isInteger(n) || n < 0 || n > 1440)
      throw new CustomError("durationMinutes debe estar entre 0 y 1440", 400);
    target.durationMinutes = n;
  }
  if (body?.priceMax !== undefined) target.priceMax = cents(body.priceMax || 0, "El precio máximo");
  if (body?.durationLabel !== undefined) target.durationLabel = str(body.durationLabel, 80);
  if (body?.deliveryNote !== undefined) target.deliveryNote = str(body.deliveryNote, 120);
  if (body?.priceNote !== undefined) target.priceNote = str(body.priceNote, 200);
  if (body?.features !== undefined) {
    if (!Array.isArray(body.features)) throw new CustomError("features debe ser una lista", 400);
    target.features = body.features.map((f: unknown) => str(f, 200)).filter(Boolean).slice(0, 20);
  }
  if (body?.variants !== undefined) target.variants = parseVariants(body.variants);
  if (body?.priceTiers !== undefined) target.priceTiers = parseTiers(body.priceTiers);
  if (body?.minQty !== undefined) {
    const n = Number(body.minQty);
    if (!Number.isInteger(n) || n < 1 || n > 100)
      throw new CustomError("La cantidad mínima debe ser un entero de 1 a 100", 400);
    target.minQty = n;
  }
  if (body?.isExtra !== undefined) target.isExtra = Boolean(body.isExtra);
  if (body?.active !== undefined) target.active = Boolean(body.active);
  if (body?.order !== undefined) target.order = Number(body.order) || 0;
}

function parseVariants(raw: unknown) {
  if (!Array.isArray(raw)) throw new CustomError("variants debe ser una lista", 400);
  const out = raw.map((v: any) => {
    const label = str(v?.label, 120);
    if (!label) throw new CustomError("Cada opción necesita un nombre", 400);
    const price = cents(v?.price, `El precio de "${label}"`);
    const priceMax = v?.priceMax ? cents(v.priceMax, `El precio máximo de "${label}"`) : 0;
    if (priceMax && priceMax < price)
      throw new CustomError(`El máximo de "${label}" no puede ser menor que el precio`, 400);
    const d = Number(v?.durationMinutes ?? 0);
    if (!Number.isInteger(d) || d < 0 || d > 1440)
      throw new CustomError(`Duración inválida en "${label}"`, 400);
    return { label, price, priceMax, durationMinutes: d };
  });
  const labels = new Set(out.map((v) => v.label.toLowerCase()));
  if (labels.size !== out.length) throw new CustomError("Hay opciones con el mismo nombre", 400);
  return out;
}

function parseTiers(raw: unknown) {
  if (!Array.isArray(raw)) throw new CustomError("priceTiers debe ser una lista", 400);
  const out = raw.map((t: any) => {
    const minQty = Number(t?.minQty);
    if (!Number.isInteger(minQty) || minQty < 1 || minQty > 1000)
      throw new CustomError("Cada tramo necesita una cantidad mínima entera ≥ 1", 400);
    return { minQty, unitPrice: cents(t?.unitPrice, "El precio del tramo") };
  });
  if (new Set(out.map((t) => t.minQty)).size !== out.length)
    throw new CustomError("Hay tramos con la misma cantidad mínima", 400);
  return out.sort((a, b) => a.minQty - b.minQty);
}

/** Con variantes, `price` es el menor de ellas: así "desde $X" siempre cuadra. */
function syncBasePrice(target: any) {
  if (target.variants?.length) {
    target.price = Math.min(...target.variants.map((v: any) => v.price));
  } else if (target.priceTiers?.length) {
    target.price = Math.min(...target.priceTiers.map((t: any) => t.unitPrice));
  }
}

async function uniqueSlug(base: string, exceptId?: string): Promise<string> {
  let slug = base || "servicio";
  for (
    let i = 2;
    await Service.exists({ slug, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
    i++
  ) {
    slug = `${base}-${i}`;
  }
  return slug;
}

export async function createService(body: any) {
  const data: any = {};
  applyFields(data, body);
  if (!data.name) throw new CustomError("El nombre es obligatorio", 400);
  syncBasePrice(data);
  if (data.price === undefined) throw new CustomError("El precio es obligatorio", 400);
  data.slug = await uniqueSlug(slugify(str(body?.slug, 80) || data.name));
  return (await Service.create(data)).toObject();
}

export async function updateService(id: string, body: any) {
  assertObjectId(id, "el servicio");
  const service = await Service.findById(id);
  if (!service) throw new CustomError("Servicio no encontrado", 404);
  applyFields(service, body);
  syncBasePrice(service);
  if (!service.name) throw new CustomError("El nombre es obligatorio", 400);
  if (body?.slug !== undefined) service.slug = await uniqueSlug(slugify(str(body.slug, 80)), id);
  await service.save();
  return service.toObject();
}

/** DELETE = desactivar: los pedidos viejos siguen apuntando al servicio. */
export async function deactivateService(id: string) {
  assertObjectId(id, "el servicio");
  const s = await Service.findByIdAndUpdate(id, { $set: { active: false } }, { new: true }).lean();
  if (!s) throw new CustomError("Servicio no encontrado", 404);
  return s;
}
