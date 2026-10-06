import { isConnected } from "../config/mongo";
import { Branch } from "../models/branch.model";
import { Service } from "../models/service.model";
import { slugify } from "../utils/http";
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

type SeedService = {
  name: string;
  slug?: string;
  category: string;
  price: number;
  unit?: string;
  durationMinutes: number;
  isExtra?: boolean;
  description: string;
};

/** Precios de ejemplo en centavos: gerencia los ajusta desde el panel. */
const SERVICES: SeedService[] = [
  {
    name: "Limpieza de tapicería de auto",
    category: "vehiculos",
    price: 6000,
    durationMinutes: 120,
    description: "Lavado profundo de asientos, alfombras y paneles con extracción.",
  },
  {
    name: "Colchón 1 plaza",
    category: "colchones",
    price: 2500,
    durationMinutes: 40,
    description: "Limpieza y desinfección por ambas caras.",
  },
  {
    name: "Colchón 2 plazas",
    category: "colchones",
    price: 3500,
    durationMinutes: 50,
    description: "Limpieza y desinfección por ambas caras.",
  },
  {
    name: "Colchón 2½ plazas",
    slug: "colchon-2-5-plazas",
    category: "colchones",
    price: 4000,
    durationMinutes: 55,
    description: "Limpieza y desinfección por ambas caras.",
  },
  {
    name: "Colchón King",
    category: "colchones",
    price: 4500,
    durationMinutes: 60,
    description: "Limpieza y desinfección por ambas caras.",
  },
  {
    name: "Almohada",
    category: "colchones",
    price: 500,
    durationMinutes: 10,
    description: "Limpieza y desinfección de almohada.",
  },
  {
    name: "Silla de comedor",
    category: "muebles",
    price: 500,
    durationMinutes: 10,
    description: "Limpieza de asiento y espaldar tapizado.",
  },
  {
    name: "Silla de oficina",
    category: "muebles",
    price: 700,
    durationMinutes: 15,
    description: "Limpieza de tapiz de silla ergonómica.",
  },
  {
    name: "Sofá por puesto",
    category: "muebles",
    price: 1200,
    durationMinutes: 20,
    description: "Precio por cada puesto del sofá.",
  },
  {
    name: "Alfombra por m²",
    category: "alfombras",
    price: 300,
    unit: "m2",
    durationMinutes: 5,
    description: "Lavado de alfombra, precio por metro cuadrado.",
  },
  {
    name: "Cortinas por m²",
    category: "hogar",
    price: 250,
    unit: "m2",
    durationMinutes: 5,
    description: "Lavado de cortinas en sitio, precio por metro cuadrado.",
  },
  {
    name: "Limpieza profunda de hogar",
    category: "hogar",
    price: 8000,
    unit: "servicio",
    durationMinutes: 240,
    description: "Limpieza profunda de cocina, baños, pisos y superficies.",
  },
  {
    name: "Desodorización",
    category: "otros",
    price: 500,
    unit: "servicio",
    durationMinutes: 10,
    isExtra: true,
    description: "Elimina malos olores.",
  },
  {
    name: "Impermeabilización",
    category: "otros",
    price: 1000,
    unit: "servicio",
    durationMinutes: 15,
    isExtra: true,
    description: "Protege la tela contra líquidos y manchas.",
  },
  {
    name: "Desinfección anti-ácaros",
    category: "otros",
    price: 800,
    unit: "servicio",
    durationMinutes: 10,
    isExtra: true,
    description: "Tratamiento contra ácaros y bacterias.",
  },
  {
    name: "Retiro de manchas difíciles",
    category: "otros",
    price: 700,
    unit: "servicio",
    durationMinutes: 15,
    isExtra: true,
    description: "Tratamiento localizado de manchas rebeldes.",
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
      await Service.insertMany(
        SERVICES.map((s, i) => ({
          ...s,
          slug: s.slug ?? slugify(s.name),
          unit: s.unit ?? "unidad",
          isExtra: s.isExtra ?? false,
          order: (i + 1) * 10,
        })),
        // Sin orden: un duplicado no corta la carga del resto.
        { ordered: false },
      );
      console.log(`[seed] catálogo creado (${SERVICES.length} servicios)`);
    }
    await getSettings();
  } catch (error) {
    console.error("[seed] no se pudieron crear los datos base:", (error as Error).message);
  }
  // Va aparte: la cuenta de gerencia no puede depender de que el catálogo cargue bien.
  await seedAdmin();
}
