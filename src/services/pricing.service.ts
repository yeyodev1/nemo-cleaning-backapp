import { isValidObjectId } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { IBookingItem } from "../models/booking.model";
import { Service } from "../models/service.model";

const MIN_DURATION = 30;
const MAX_DURATION = 8 * 60;

export interface PricedOrder {
  items: IBookingItem[];
  subtotal: number;
  total: number;
  durationMinutes: number;
}

/**
 * Recalcula precios desde el catálogo: el precio que manda el navegador no se
 * usa nunca. Las cantidades por m² admiten decimales (2 cifras); el resto, enteros.
 */
export async function priceItems(
  rawInput: unknown,
  { allowInactive = false, allowCustom = false } = {},
): Promise<PricedOrder> {
  if (!Array.isArray(rawInput) || rawInput.length === 0) {
    throw new CustomError("Agrega al menos un servicio al pedido", 400);
  }
  if (rawInput.length > 50) throw new CustomError("Demasiados servicios en un pedido", 400);

  // Líneas libres (solo panel): { name, unitPrice, quantity } sin servicio del catálogo.
  const customItems: IBookingItem[] = [];
  const rawItems = rawInput.filter((i: any) => {
    if (!allowCustom || i?.service) return true;
    const name = String(i?.name ?? "")
      .trim()
      .slice(0, 160);
    const unitPrice = Number(i?.unitPrice);
    const quantity = Number(i?.quantity ?? 1);
    if (!name) throw new CustomError("Cada línea libre necesita un nombre", 400);
    if (!Number.isInteger(unitPrice) || unitPrice < 0) {
      throw new CustomError(`Precio inválido en "${name}" (centavos enteros)`, 400);
    }
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 10000) {
      throw new CustomError(`Cantidad inválida en "${name}"`, 400);
    }
    const q = Math.round(quantity * 100) / 100;
    customItems.push({
      service: null,
      name,
      unitPrice,
      quantity: q,
      subtotal: Math.round(unitPrice * q),
      isExtra: false,
    });
    return false;
  });

  const ids = rawItems.map((i: any) => String(i?.service ?? ""));
  if (ids.some((id) => !isValidObjectId(id)))
    throw new CustomError("Servicio inválido en el pedido", 400);

  const services = await Service.find({ _id: { $in: ids } }).lean();
  const byId = new Map(services.map((s) => [String(s._id), s]));

  // Si el mismo servicio viene dos veces se suman las cantidades.
  const merged = new Map<string, number>();
  for (const raw of rawItems as any[]) {
    const id = String(raw.service);
    const service = byId.get(id);
    if (!service || (!service.active && !allowInactive)) {
      throw new CustomError("Uno de los servicios ya no está disponible", 400);
    }
    const q = Number(raw.quantity ?? 1);
    const valid =
      service.unit === "m2"
        ? Number.isFinite(q) && q > 0 && q <= 10000
        : Number.isInteger(q) && q > 0 && q <= 100;
    if (!valid) {
      throw new CustomError(
        service.unit === "m2"
          ? `Cantidad inválida para "${service.name}" (m² mayor a 0)`
          : `Cantidad inválida para "${service.name}" (entero de 1 a 100)`,
        400,
      );
    }
    merged.set(id, (merged.get(id) ?? 0) + Math.round(q * 100) / 100);
  }

  const items: IBookingItem[] = [...customItems];
  // Una línea libre no tiene duración en el catálogo: se asume un turno.
  let duration = customItems.length ? 60 : 0;
  for (const [id, quantity] of merged) {
    const s = byId.get(id)!;
    items.push({
      service: s._id as any,
      name: s.name,
      unitPrice: s.price,
      quantity,
      subtotal: Math.round(s.price * quantity),
      isExtra: s.isExtra,
    });
    duration += (s.durationMinutes ?? 0) * quantity;
  }
  if (!items.some((i) => !i.isExtra)) {
    throw new CustomError("Los adicionales se agregan junto a un servicio principal", 400);
  }

  const subtotal = items.reduce((sum, i) => sum + i.subtotal, 0);
  return {
    items,
    subtotal,
    total: subtotal,
    durationMinutes: Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(duration))),
  };
}

export async function quote(body: any) {
  return priceItems(body?.items);
}
