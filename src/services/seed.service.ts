import { isConnected } from "../config/mongo";
import { Branch } from "../models/branch.model";
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
 * Datos base idempotentes: sucursales que falten (por slug), catálogo solo si
 * está vacío (para no revivir servicios borrados desde el panel), settings y
 * la cuenta de gerencia. Es barato: corre en cada arranque en frío.
 */
export async function seedBaseData(): Promise<void> {
  if (!isConnected()) return;
  try {
    for (const b of BRANCHES) {
      await Branch.updateOne({ slug: b.slug }, { $setOnInsert: b }, { upsert: true });
    }
    if ((await Service.estimatedDocumentCount()) === 0) {
      // Sin orden: un duplicado no corta la carga del resto.
      await Service.insertMany(REAL_CATALOG.map(toServiceDoc), { ordered: false });
      console.log(`[seed] catálogo real creado (${REAL_CATALOG.length} servicios)`);
    }
    await getSettings();
  } catch (error) {
    console.error("[seed] no se pudieron crear los datos base:", (error as Error).message);
  }
  // Va aparte: la cuenta de gerencia no puede depender de que el catálogo cargue bien.
  await seedAdmin();
}
