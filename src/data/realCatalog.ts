/**
 * Catálogo REAL de Nemo (fuente: recursos/MARCA.md y los PDF oficiales NEMO CAR y
 * NEMO HOME & OFFICE). Precios en centavos. No agregar nada que no esté en el catálogo.
 *
 * `durationMinutes` es solo para la agenda interna: donde el catálogo no da tiempo se usa
 * un valor por defecto razonable y NO se muestra en la web (para eso está `durationLabel`).
 * Las fotos se sirven desde el front (`public/fotos/`).
 */

export interface CatalogVariant {
  label: string;
  price: number;
  priceMax?: number;
  durationMinutes?: number;
}

export interface CatalogItem {
  slug: string;
  name: string;
  category:
    | "autos"
    | "alfombras"
    | "muebles"
    | "colchones"
    | "especializados"
    | "oficinas"
    | "infantiles";
  description?: string;
  imageUrl?: string;
  price?: number;
  unit?: "unidad" | "m2" | "servicio";
  durationMinutes?: number;
  durationLabel?: string;
  deliveryNote?: string;
  priceNote?: string;
  features?: string[];
  variants?: CatalogVariant[];
  priceTiers?: { minQty: number; unitPrice: number }[];
  minQty?: number;
  isExtra?: boolean;
}

/** Tamaños de vehículo del catálogo; algunos servicios juntan Pequeño y Mediano. */
const car4 = (p: number, m: number, g: number, xl: number): CatalogVariant[] => [
  { label: "Pequeño", price: p },
  { label: "Mediano", price: m },
  { label: "Grande", price: g },
  { label: "Extra Grande", price: xl },
];
const car3 = (pm: number, g: number, xl: number): CatalogVariant[] => [
  { label: "Pequeño y Mediano", price: pm },
  { label: "Grande", price: g },
  { label: "Extra Grande", price: xl },
];

export const FURNITURE_RANGE_NOTE =
  "El valor final se confirma según el estado/material del mueble.";

export const REAL_CATALOG: CatalogItem[] = [
  // ------------------------------------------------------------------ NEMO CAR
  {
    slug: "classic-wash",
    name: "Classic Wash",
    category: "autos",
    unit: "servicio",
    imageUrl: "/fotos/auto-faros.webp",
    features: [
      "Limpieza de carrocería",
      "Aspirada interna",
      "Limpieza de tableros, puertas y asientos",
      "Aplicación de brillo en llantas",
      "Aromatización",
    ],
    variants: car4(800, 1000, 1200, 1500),
    durationMinutes: 60,
    durationLabel: "aprox. 1 hora",
  },
  {
    slug: "premium-wash",
    name: "Premium Wash",
    category: "autos",
    unit: "servicio",
    imageUrl: "/fotos/auto-antes-despues.webp",
    features: [
      "Baño de espuma y limpieza total externa",
      "Removedor de grasa en partes plásticas y aros",
      "Aspirada interna de asientos, alfombras y puntos ciegos",
      "Limpieza del techo",
      "Desinfección de la cabina con ozono",
      "Encerada",
      "Ambientador",
    ],
    variants: car4(3500, 4500, 5500, 6500),
    durationMinutes: 120,
    durationLabel: "aprox. 2 horas",
  },
  {
    slug: "detailing-pro",
    name: "Detailing Pro",
    category: "autos",
    unit: "servicio",
    imageUrl: "/fotos/auto-detailing-pro.webp",
    description:
      "Lavado al detalle de todas las zonas y accesorios del vehículo. Línea de limpieza Chemical Brothers, Meguiars y microfibra Kirkland (Made in USA). 9 puntos a tratar.",
    features: [
      "Descontaminación de carrocería con sistema CLAY BAR",
      "Limpieza al detalle con spray y brocha en volante, panel, asientos, techos, postes, plásticos, emblemas, rieles y neumáticos",
      "Aspirado total filtrado",
      "Desinfección de olores y bacterias",
      "Baño interno de vapor",
      "Limpieza de asientos (removidos del vehículo)",
      "Hidratación de cueros y tapizados",
      "Encerada",
      "Ambientador",
    ],
    variants: car3(8500, 9500, 10500),
    durationMinutes: 60,
    durationLabel: "aprox. 1 hora",
  },
  {
    slug: "detailing-interior",
    name: "Detailing Interior",
    category: "autos",
    unit: "servicio",
    imageUrl: "/fotos/auto-interior.webp",
    features: [
      "Limpieza profunda de cabina",
      "Eliminación de suciedad acumulada",
      "Desinfección y restauración de superficies internas",
    ],
    variants: car3(4000, 4500, 5000),
    durationMinutes: 60,
  },
  {
    slug: "detailing-exterior",
    name: "Detailing Exterior",
    category: "autos",
    unit: "servicio",
    imageUrl: "/fotos/auto-antes-despues.webp",
    features: ["Lavado profundo", "Descontaminación", "Restauración del brillo de la pintura"],
    variants: car3(4000, 4500, 5000),
    durationMinutes: 60,
    durationLabel: "aprox. 1 hora",
  },
  {
    slug: "ceramic-pro-silver",
    name: "Ceramic Pro Coating Grafeno 9H · Paquete Silver",
    category: "autos",
    unit: "servicio",
    imageUrl: "/fotos/auto-aros.webp",
    description:
      "Revestimiento cerámico de grafeno aplicado en carrocería, aros, vidrios, faros y plásticos externos. Duración del recubrimiento: 6 a 10 meses.",
    features: [
      "Micropulido efecto espejo",
      "Protección de carrocería con capa de brillo",
      "Recubrimiento cerámico en aros",
      "Protección en parabrisas y retrovisores",
      "Protección en faros",
      "Protección en partes plásticas externas",
    ],
    variants: car3(16000, 20000, 25000),
    durationMinutes: 360,
    durationLabel: "aprox. 6 horas",
  },
  {
    slug: "ceramic-pro-gold",
    name: "Ceramic Pro Coating Grafeno 9H · Paquete Gold",
    category: "autos",
    unit: "servicio",
    imageUrl: "/fotos/auto-detailing.webp",
    description:
      "Mantiene tu vehículo protegido y con apariencia de nuevo por más de un año.",
    features: [
      "Micropulido tipo espejo con efecto hidrofóbico",
      "Protección contra rayones leves",
      "Protección UV",
      "Recubrimiento cerámico en aros",
      "Protección en parabrisas y retrovisores",
      "Protección en faros",
      "Protección en partes plásticas externas",
    ],
    variants: car3(25000, 30000, 36000),
    durationMinutes: 360,
    durationLabel: "aprox. 6 horas",
  },
  {
    slug: "signature-gtechniq",
    name: "Signature Gtechniq Process",
    category: "autos",
    unit: "servicio",
    imageUrl: "/fotos/auto-suv.webp",
    description:
      "Efecto showroom. Eleva tu vehículo a un nivel superior mediante tecnología cerámica profesional.",
    features: [
      "Brillo profundo tipo “espejo líquido”",
      "Protección contra rayos UV, químicos y contaminación",
      "Superficie ultra hidrofóbica (efecto repelente al agua)",
      "Mayor facilidad de limpieza",
      "Conservación del valor del vehículo",
      "Protección profesional real",
      "Acabado tipo exhibición (showroom finish)",
    ],
    variants: car3(35000, 45500, 54500),
    durationMinutes: 60,
  },

  // ---------------------------------------------------- adicionales de auto
  {
    slug: "encerada",
    name: "Encerada",
    category: "autos",
    unit: "servicio",
    isExtra: true,
    description: "Servicio adicional del Classic Wash.",
    price: 500,
    durationMinutes: 30,
  },
  {
    slug: "desinfeccion-de-vidrios",
    name: "Desinfección de vidrios",
    category: "autos",
    unit: "servicio",
    isExtra: true,
    description: "Incluye Classic Wash.",
    variants: [
      { label: "Pequeño y Mediano", price: 3500 },
      { label: "Grande", price: 4500 },
    ],
    durationMinutes: 30,
  },
  {
    slug: "limpieza-asientos-de-tela",
    name: "Limpieza de asientos de tela",
    category: "autos",
    unit: "servicio",
    isExtra: true,
    price: 4000,
    durationMinutes: 30,
  },
  {
    slug: "limpieza-hidratacion-de-cuero",
    name: "Limpieza e hidratación de cuero",
    category: "autos",
    unit: "servicio",
    isExtra: true,
    price: 5000,
    durationMinutes: 30,
  },
  {
    slug: "limpieza-desinfeccion-cinturones",
    name: "Limpieza y desinfección de cinturones",
    category: "autos",
    unit: "servicio",
    isExtra: true,
    price: 2000,
    durationMinutes: 30,
  },
  {
    slug: "eliminacion-de-olores",
    name: "Eliminación de olores (AirBomb Meguiars)",
    category: "autos",
    unit: "servicio",
    isExtra: true,
    price: 2500,
    durationMinutes: 30,
  },
  {
    slug: "tratamiento-de-plasticos",
    name: "Tratamiento de plásticos",
    category: "autos",
    unit: "servicio",
    isExtra: true,
    variants: [
      { label: "Externo", price: 1500 },
      { label: "Interno", price: 1500 },
      { label: "Combo", price: 2500 },
    ],
    durationMinutes: 30,
  },
  {
    slug: "limpieza-de-techo",
    name: "Limpieza de techo",
    category: "autos",
    unit: "servicio",
    isExtra: true,
    price: 3000,
    durationMinutes: 30,
  },
  {
    slug: "limpieza-de-piso",
    name: "Limpieza de piso",
    category: "autos",
    unit: "servicio",
    isExtra: true,
    variants: [
      { label: "Básico", price: 4000 },
      { label: "Con desmontaje", price: 6000 },
    ],
    durationMinutes: 30,
  },
  {
    slug: "encerada-con-maquina",
    name: "Encerada con máquina",
    category: "autos",
    unit: "servicio",
    isExtra: true,
    price: 1500,
    durationMinutes: 30,
  },

  // -------------------------------------------------------- NEMO HOME & OFFICE
  {
    slug: "limpieza-de-alfombras",
    name: "Limpieza de alfombras",
    category: "alfombras",
    imageUrl: "/fotos/alfombra-antes-despues.webp",
    features: [
      "Limpieza profunda",
      "Secado controlado",
      "Eliminación de manchas (cuando es posible)",
      "Desinfección",
      "Aromatización (neutra o personalizada)",
    ],
    variants: [
      { label: "1.80 x 0.60 m", price: 1500 },
      { label: "1.80/2 x 1.20 m", price: 2000 },
      { label: "2.40 x 1.80 m", price: 3000 },
      { label: "2.40 x 3.00 m", price: 3500 },
      { label: "Oversize", price: 4000 },
    ],
    durationMinutes: 60,
    deliveryNote: "Tiempo de entrega: 24 – 48 horas",
  },
  {
    slug: "limpieza-de-sillas",
    name: "Limpieza de sillas",
    category: "muebles",
    description: "Limpieza de muebles por pieza.",
    features: [
      "Eliminación de ácaros mediante sistema de ozono",
      "Luz UV",
      "Inyección y succión profunda",
    ],
    variants: [
      { label: "Sillas de tela", price: 650 },
      { label: "Sillas mixtas", price: 700 },
    ],
    durationMinutes: 15,
    durationLabel: "Tiempo de ejecución + secado: 2 – 5 horas",
  },
  {
    slug: "limpieza-de-sofas",
    name: "Limpieza de sofás",
    category: "muebles",
    imageUrl: "/fotos/sofa-antes-despues.webp",
    description: "Limpieza de muebles por pieza.",
    features: [
      "Eliminación de ácaros mediante sistema de ozono",
      "Luz UV",
      "Inyección y succión profunda",
    ],
    variants: [
      { label: "Sofá 1 puesto", price: 1500, priceMax: 2000 },
      { label: "Sofá 2 puestos", price: 3000, priceMax: 3500 },
      { label: "Sofá 3 puestos", price: 4000, priceMax: 5000 },
      { label: "Seccional (L / sala completa)", price: 6500, priceMax: 9000 },
    ],
    priceNote: FURNITURE_RANGE_NOTE,
    durationMinutes: 120,
    durationLabel: "Tiempo de ejecución + secado: 2 – 5 horas",
  },
  {
    slug: "limpieza-de-colchones",
    name: "Limpieza de colchones",
    category: "colchones",
    imageUrl: "/fotos/colchon-antes-despues.webp",
    description: "El precio incluye la limpieza de 2 almohadas.",
    features: [
      "Eliminación de ácaros mediante ozono",
      "Luz UV",
      "Inyección y extracción profunda",
    ],
    variants: [
      { label: "Twin", price: 2000 },
      { label: "Full", price: 2500 },
      { label: "Queen", price: 3000 },
      { label: "King", price: 3500 },
    ],
    durationMinutes: 60,
  },
  {
    slug: "limpieza-de-ventanales",
    name: "Limpieza de ventanales",
    category: "especializados",
    description: "Precio por unidad según la cantidad. Desde 2 ventanales.",
    priceTiers: [
      { minQty: 2, unitPrice: 800 },
      { minQty: 6, unitPrice: 650 },
      { minQty: 11, unitPrice: 500 },
    ],
    minQty: 2,
    durationMinutes: 60,
  },
  {
    slug: "desinfeccion-de-sanitarios",
    name: "Desinfección de sanitarios",
    category: "especializados",
    description: "Precio por baño según la cantidad.",
    features: [
      "Vapor a alta temperatura",
      "Eliminación de manchas amarillas",
      "Limpieza de puntos ciegos",
      "Desinfección completa del área",
    ],
    priceTiers: [
      { minQty: 1, unitPrice: 2500 },
      { minQty: 2, unitPrice: 2000 },
      { minQty: 4, unitPrice: 1800 },
    ],
    durationMinutes: 60,
  },
  {
    slug: "limpieza-de-patios-y-callejones",
    name: "Limpieza de patios y callejones",
    category: "especializados",
    unit: "m2",
    description: "Servicio integral según el nivel de suciedad. Precio por m².",
    features: ["Uso de químicos según necesidad", "Hidrolavado", "Desinfección"],
    variants: [
      { label: "Plan Basic", price: 110 },
      { label: "Plan Medium", price: 160 },
      { label: "Plan Intense (moho / maleza)", price: 250 },
    ],
    durationMinutes: 120,
    durationLabel: "Tiempo: 1 – 3 horas",
  },
  {
    slug: "limpieza-de-oficinas",
    name: "Limpieza de oficinas",
    category: "oficinas",
    unit: "m2",
    imageUrl: "/fotos/oficina.webp",
    description:
      "Ideal para mantenimiento mensual, entrega de oficinas y post-construcción. Precio por m²; el plan mensual tiene tarifa especial.",
    features: [
      "Limpieza general",
      "Aspirado",
      "Desinfección de sanitarios",
      "Ozonificación",
      "Limpieza de ventanales",
      "Aromatización",
    ],
    variants: [
      { label: "Básico", price: 250 },
      { label: "Profundo", price: 300 },
    ],
    durationMinutes: 180,
  },
  {
    slug: "accesorios-infantiles",
    name: "Accesorios infantiles",
    category: "infantiles",
    description: "Servicio especializado en limpieza y desinfección segura.",
    variants: [
      { label: "Tapetes / mats", price: 1500 },
      { label: "Car seat", price: 1000 },
      { label: "Stroller (simple)", price: 1000 },
      { label: "Stroller (doble)", price: 1500 },
    ],
    durationMinutes: 30,
  },
];

/** Slugs del catálogo de ejemplo que se sembró al inicio (fase 1); la migración los retira. */
export const LEGACY_EXAMPLE_SLUGS = [
  "limpieza-de-tapiceria-de-auto",
  "colchon-1-plaza",
  "colchon-2-plazas",
  "colchon-2-5-plazas",
  "colchon-king",
  "almohada",
  "silla-de-comedor",
  "silla-de-oficina",
  "sofa-por-puesto",
  "alfombra-por-m",
  "alfombra-por-m2",
  "cortinas-por-m",
  "cortinas-por-m2",
  "limpieza-profunda-de-hogar",
  "desodorizacion",
  "impermeabilizacion",
  "desinfeccion-anti-acaros",
  "retiro-de-manchas-dificiles",
];

/** Documento listo para Mongo: precio base = el menor de variantes o tramos ("desde $X"). */
export function toServiceDoc(item: CatalogItem, index: number) {
  const variants = (item.variants ?? []).map((v) => ({
    label: v.label,
    price: v.price,
    priceMax: v.priceMax ?? 0,
    durationMinutes: v.durationMinutes ?? 0,
  }));
  const tiers = item.priceTiers ?? [];
  const price = variants.length
    ? Math.min(...variants.map((v) => v.price))
    : tiers.length
      ? Math.min(...tiers.map((t) => t.unitPrice))
      : (item.price ?? 0);
  return {
    slug: item.slug,
    name: item.name,
    category: item.category,
    description: item.description ?? "",
    imageUrl: item.imageUrl ?? "",
    price,
    priceMax: 0,
    unit: item.unit ?? "unidad",
    durationMinutes: item.durationMinutes ?? 60,
    durationLabel: item.durationLabel ?? "",
    deliveryNote: item.deliveryNote ?? "",
    priceNote: item.priceNote ?? "",
    features: item.features ?? [],
    variants,
    priceTiers: tiers,
    minQty: item.minQty ?? 1,
    isExtra: item.isExtra ?? false,
    active: true,
    order: (index + 1) * 10,
  };
}
