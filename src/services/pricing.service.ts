import { isValidObjectId } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { IBookingItem } from "../models/booking.model";
import { IService, Service } from "../models/service.model";
import { str } from "../utils/http";
import { tierMinQty, tierUnitPrice } from "../utils/tiers";

const MIN_DURATION = 30;
const MAX_DURATION = 8 * 60;

export interface PricedOrder {
  items: IBookingItem[];
  subtotal: number;
  total: number;
  durationMinutes: number;
}

/**
 * Precio de una línea del catálogo. Reglas (el front las replica en `utils/pricing.ts`):
 * - con variantes: el precio de la opción elegida (con rango, se cobra el menor);
 * - con tramos: el precio del tramo alcanzado para todas las unidades, respetando el mínimo;
 * - si no, el precio base. Las líneas por m² multiplican por m² (decimales).
 * La duración interna se multiplica por la cantidad solo en servicios por unidad sin tramos:
 * 6 ventanales o 40 m² no son 6 o 40 turnos.
 */
export function priceLine(
  s: Pick<IService, "name" | "price" | "priceMax" | "unit" | "durationMinutes" | "minQty"> & {
    variants?: IService["variants"];
    priceTiers?: IService["priceTiers"];
  },
  variant: string,
  quantity: number,
) {
  let unitPrice = s.price;
  let unitPriceMax = s.priceMax ?? 0;
  let perUnitDuration = s.durationMinutes ?? 0;
  const v = s.variants?.find((x) => x.label === variant);
  if (v) {
    unitPrice = v.price;
    unitPriceMax = v.priceMax ?? 0;
    if (v.durationMinutes) perUnitDuration = v.durationMinutes;
  }
  const tiers = s.priceTiers ?? [];
  const minQty = Math.max(s.minQty ?? 1, tiers.length ? tierMinQty(tiers) : 1);
  if (quantity < minQty) {
    throw new CustomError(`"${s.name}" se contrata desde ${minQty} unidades`, 400);
  }
  if (tiers.length) {
    const tierPrice = tierUnitPrice(tiers, quantity);
    if (tierPrice === null) {
      throw new CustomError(`"${s.name}" se contrata desde ${minQty} unidades`, 400);
    }
    unitPrice = tierPrice;
    unitPriceMax = 0;
  }
  const multiplies = s.unit !== "m2" && !tiers.length;
  return {
    unitPrice,
    unitPriceMax: unitPriceMax > unitPrice ? unitPriceMax : 0,
    duration: multiplies ? perUnitDuration * quantity : perUnitDuration,
  };
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
      variant: "",
      unitPrice,
      unitPriceMax: 0,
      unit: "unidad",
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

  // Si el mismo servicio (y la misma opción) viene dos veces se suman las cantidades:
  // así los tramos por cantidad se calculan sobre el total.
  const merged = new Map<string, { id: string; variant: string; quantity: number }>();
  for (const raw of rawItems as any[]) {
    const id = String(raw.service);
    const service = byId.get(id);
    if (!service || (!service.active && !allowInactive)) {
      throw new CustomError("Uno de los servicios ya no está disponible", 400);
    }
    const variant = str(raw.variant, 120);
    if (service.variants?.length) {
      if (!variant) throw new CustomError(`Elige una opción para "${service.name}"`, 400);
      if (!service.variants.some((v) => v.label === variant)) {
        throw new CustomError(`La opción "${variant}" ya no existe en "${service.name}"`, 400);
      }
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
    const key = `${id}|${service.variants?.length ? variant : ""}`;
    const row = merged.get(key) ?? { id, variant: service.variants?.length ? variant : "", quantity: 0 };
    row.quantity = Math.round((row.quantity + q) * 100) / 100;
    merged.set(key, row);
  }

  const items: IBookingItem[] = [...customItems];
  // Una línea libre no tiene duración en el catálogo: se asume un turno.
  let duration = customItems.length ? 60 : 0;
  for (const { id, variant, quantity } of merged.values()) {
    const s = byId.get(id)!;
    const line = priceLine(s, variant, quantity);
    items.push({
      service: s._id as any,
      name: s.name,
      variant,
      unitPrice: line.unitPrice,
      unitPriceMax: line.unitPriceMax,
      unit: s.unit,
      quantity,
      subtotal: Math.round(line.unitPrice * quantity),
      isExtra: s.isExtra,
    });
    duration += line.duration;
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
