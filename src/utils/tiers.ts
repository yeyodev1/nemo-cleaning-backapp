export interface Tier {
  minQty: number;
  unitPrice: number;
}

/**
 * Precio unitario por tramos: gana el tramo de mayor `minQty` que la cantidad alcanza
 * y ese precio se aplica a TODAS las unidades (ventanales x6 → 6 × $6,50).
 * Devuelve null si la cantidad no llega al primer tramo. El front replica esta regla.
 */
export function tierUnitPrice(tiers: Tier[], quantity: number): number | null {
  let price: number | null = null;
  let best = -Infinity;
  for (const t of tiers) {
    if (quantity >= t.minQty && t.minQty > best) {
      best = t.minQty;
      price = t.unitPrice;
    }
  }
  return price;
}

/** Cantidad mínima que piden los tramos (el `minQty` más bajo). */
export function tierMinQty(tiers: Tier[]): number {
  return tiers.length ? Math.min(...tiers.map((t) => t.minQty)) : 1;
}
