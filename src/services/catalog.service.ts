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
  if (body?.isExtra !== undefined) target.isExtra = Boolean(body.isExtra);
  if (body?.active !== undefined) target.active = Boolean(body.active);
  if (body?.order !== undefined) target.order = Number(body.order) || 0;
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
  if (data.price === undefined) throw new CustomError("El precio es obligatorio", 400);
  data.slug = await uniqueSlug(slugify(str(body?.slug, 80) || data.name));
  return (await Service.create(data)).toObject();
}

export async function updateService(id: string, body: any) {
  assertObjectId(id, "el servicio");
  const service = await Service.findById(id);
  if (!service) throw new CustomError("Servicio no encontrado", 404);
  applyFields(service, body);
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
