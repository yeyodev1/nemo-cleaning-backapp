import { isConnected } from "../config/mongo";
import { Branch, DEFAULT_SLOT_MINUTES, DEFAULT_SLOT_TIMES } from "../models/branch.model";
import { ensureUserEmailIndex } from "../models/user.model";
import { Service } from "../models/service.model";
import { REAL_CATALOG, toServiceDoc } from "../data/realCatalog";
import { seedAdmin } from "./auth.service";
import { getSettings } from "./settings.service";

const BRANCHES = [
  {
    name: "Samborondón",
    slug: "samborondon",
    address: "Samborondón, Guayas",
    phone: "",
    whatsapp: "",
    email: "",
  },
  {
    name: "Vía a la Costa",
    slug: "via-a-la-costa",
    address: "Vía a la Costa, Guayaquil",
    phone: "",
    whatsapp: "",
    email: "",
  },
];

/**
 * Zonas reales de la columna "Urbanizacion/Zona" de las Bases del Excel. Solo se
 * escriben si la sucursal aún no tiene lista (luego se editan desde el panel).
 */
const DEFAULT_ZONES: Record<string, string[]> = {
  samborondon: [
    "Ciudad Celeste",
    "La Joya-Villa Club-Matices-Condado",
    "Vía a Salitre",
    "Vía a Samborondón",
    "Zona Fuera de Cobertura",
  ],
  "via-a-la-costa": ["Vía a la Costa", "Los Ceibos", "Zona Fuera de Cobertura"],
};

/**
 * Datos base idempotentes: sucursales que falten (por slug), catálogo solo si
 * está vacío (para no revivir servicios borrados desde el panel), settings y
 * la cuenta de gerencia. Es barato: corre en cada arranque en frío.
 */
export async function seedBaseData(): Promise<void> {
  if (!isConnected()) return;
  try {
    for (const b of BRANCHES) {
      await Branch.updateOne({ slug: b.slug }, { $setOnInsert: b }, { upsert: true });
      await Branch.updateOne(
        { slug: b.slug, zones: { $exists: false } },
        { $set: { zones: DEFAULT_ZONES[b.slug] ?? [] } },
      );
      // Turnos fijos solo la primera vez: luego gerencia los edita en Sucursales.
      await Branch.updateOne(
        { slug: b.slug, slotTimes: { $exists: false } },
        { $set: { slotTimes: DEFAULT_SLOT_TIMES, slotMinutes: DEFAULT_SLOT_MINUTES } },
      );
    }
    if ((await Service.estimatedDocumentCount()) === 0) {
      // Sin orden: un duplicado no corta la carga del resto.
      await Service.insertMany(REAL_CATALOG.map(toServiceDoc), { ordered: false });
      console.log(`[seed] catálogo real creado (${REAL_CATALOG.length} servicios)`);
    }
    await getSettings();
    await ensureUserEmailIndex();
  } catch (error) {
    console.error("[seed] no se pudieron crear los datos base:", (error as Error).message);
  }
  // Va aparte: la cuenta de gerencia no puede depender de que el catálogo cargue bien.
  await seedAdmin();
}
