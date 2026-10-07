import "dotenv/config";
import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { LEGACY_EXAMPLE_SLUGS, REAL_CATALOG, toServiceDoc } from "../data/realCatalog";
import { Booking } from "../models/booking.model";
import { Service } from "../models/service.model";
import {
  DEFAULT_BATHROOM_TIERS,
  DEFAULT_WINDOW_TIERS,
  Settings,
} from "../models/setting.model";
import { getSettings } from "../services/settings.service";

/**
 * pnpm seed:catalog-real — reemplaza el catálogo de ejemplo por el catálogo REAL.
 * Idempotente:
 * - upsert por slug de cada servicio real (sobrescribe precios y textos con los del catálogo);
 * - los servicios de ejemplo se borran si ningún pedido los usa; si alguno los usa, se desactivan;
 * - cualquier otro servicio que no sea del catálogo real queda inactivo;
 * - Settings.officePricing pasa a las tarifas reales de oficinas.
 * No toca usuarios, sucursales, pedidos ni pagos.
 */
async function main() {
  const ok = await dbConnect();
  if (!ok) throw new Error("No se pudo conectar a Mongo");

  let upserted = 0;
  let updated = 0;
  for (const [i, item] of REAL_CATALOG.entries()) {
    const res = await Service.updateOne(
      { slug: item.slug },
      { $set: toServiceDoc(item, i) },
      { upsert: true, runValidators: true },
    );
    if (res.upsertedCount) upserted++;
    else if (res.modifiedCount) updated++;
  }

  const realSlugs = REAL_CATALOG.map((s) => s.slug);
  const legacy = await Service.find({ slug: { $in: LEGACY_EXAMPLE_SLUGS } }).select("_id slug").lean();
  let deleted = 0;
  let deactivated = 0;
  for (const s of legacy) {
    const used = await Booking.exists({ "items.service": s._id });
    if (used) {
      await Service.updateOne({ _id: s._id }, { $set: { active: false } });
      deactivated++;
    } else {
      await Service.deleteOne({ _id: s._id });
      deleted++;
    }
  }
  const others = await Service.updateMany(
    { slug: { $nin: [...realSlugs, ...LEGACY_EXAMPLE_SLUGS] }, active: true },
    { $set: { active: false } },
  );

  await getSettings();
  await Settings.updateOne(
    { key: "main" },
    {
      $set: {
        officePricing: {
          basicPerM2: 250,
          deepPerM2: 300,
          chairFabric: 650,
          chairMixed: 700,
          windowTiers: DEFAULT_WINDOW_TIERS,
          bathroomTiers: DEFAULT_BATHROOM_TIERS,
        },
      },
    },
  );

  const active = await Service.countDocuments({ active: true });
  console.log(
    `[catalog-real] creados ${upserted}, actualizados ${updated}, ejemplo borrados ${deleted}, ` +
      `ejemplo desactivados ${deactivated}, otros desactivados ${others.modifiedCount}; activos ahora: ${active}`,
  );
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("[catalog-real] falló:", error);
  await mongoose.disconnect();
  process.exit(1);
});
