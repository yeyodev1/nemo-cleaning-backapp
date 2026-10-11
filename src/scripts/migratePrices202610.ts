import "dotenv/config";
import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { REAL_CATALOG, toServiceDoc } from "../data/realCatalog";
import { Branch, DEFAULT_SLOT_MINUTES, DEFAULT_SLOT_TIMES } from "../models/branch.model";
import { Service } from "../models/service.model";

/**
 * pnpm migrate:2026-10 — cambios que pidió Nemo en oct-2026, sin tocar el resto del catálogo
 * (a diferencia de `seed:catalog-real`, no pisa lo que gerencia editó en otros servicios):
 * - Detailing Interior desde $55 con techo o asientos a elección;
 * - alfombras desde $20 y entrega de 48 a 72 horas;
 * - limpieza de techo $25 / $30 por tamaño;
 * - turnos fijos 8:00 · 9:30 · 11:00 · 13:00 · 14:30 · 16:00 en las dos sucursales.
 * Idempotente.
 */
const SLUGS = ["detailing-interior", "limpieza-de-alfombras", "limpieza-de-techo"];
const FIELDS = [
  "price",
  "variants",
  "features",
  "deliveryNote",
  "choices",
  "choiceLabel",
] as const;

async function main() {
  if (!(await dbConnect())) throw new Error("No se pudo conectar a Mongo");

  for (const slug of SLUGS) {
    const i = REAL_CATALOG.findIndex((s) => s.slug === slug);
    const doc = toServiceDoc(REAL_CATALOG[i]!, i);
    const $set = Object.fromEntries(FIELDS.map((f) => [f, doc[f]]));
    const res = await Service.updateOne({ slug }, { $set }, { runValidators: true });
    console.log(`[2026-10] ${slug}: ${res.matchedCount ? (res.modifiedCount ? "actualizado" : "sin cambios") : "NO EXISTE"}`);
  }

  const branches = await Branch.updateMany(
    { slug: { $in: ["samborondon", "via-a-la-costa"] } },
    { $set: { slotTimes: DEFAULT_SLOT_TIMES, slotMinutes: DEFAULT_SLOT_MINUTES } },
  );
  console.log(`[2026-10] turnos fijos en ${branches.modifiedCount} sucursal(es)`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("[2026-10] falló:", error);
  await mongoose.disconnect();
  process.exit(1);
});
