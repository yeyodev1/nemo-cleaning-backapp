import mongoose, { Schema, Document } from "mongoose";

/** Categorías del catálogo real: "autos" es la línea NEMO CAR; el resto, NEMO HOME & OFFICE. */
export const SERVICE_CATEGORIES = [
  "autos",
  "alfombras",
  "muebles",
  "colchones",
  "especializados",
  "oficinas",
  "infantiles",
] as const;
export const SERVICE_UNITS = ["unidad", "m2", "servicio"] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/** Opción de precio (tamaño de vehículo, medida de alfombra, plan por m²…). */
export interface IServiceVariant {
  label: string;
  price: number;
  /** Solo para mostrar el rango ("$15 – $20"); se cobra `price`. 0 = sin rango. */
  priceMax: number;
  /** Duración interna para la agenda; 0 = la del servicio. */
  durationMinutes: number;
}

/** Tramo por cantidad: el precio del tramo alcanzado se aplica a todas las unidades. */
export interface IPriceTier {
  minQty: number;
  unitPrice: number;
}

export interface IService extends Document {
  name: string;
  slug: string;
  category: ServiceCategory;
  description: string;
  imageUrl: string;
  /** Precio base en centavos (sin variantes ni tramos). Con variantes = el menor, para "desde". */
  price: number;
  priceMax: number;
  unit: (typeof SERVICE_UNITS)[number];
  /** Duración interna para la agenda. No se muestra en la web como dato. */
  durationMinutes: number;
  /** Texto visible: "aprox. 1 hora". Vacío = no se muestra. */
  durationLabel: string;
  /** Texto visible: "entrega 24–48 horas". */
  deliveryNote: string;
  /** Nota visible junto al precio (p. ej. el aviso de los rangos de muebles). */
  priceNote: string;
  features: string[];
  variants: IServiceVariant[];
  priceTiers: IPriceTier[];
  /** Cantidad mínima por pedido (ventanales: 2). */
  minQty: number;
  isExtra: boolean;
  active: boolean;
  order: number;
}

const variantSchema = new Schema<IServiceVariant>(
  {
    label: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    priceMax: { type: Number, default: 0, min: 0 },
    durationMinutes: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const tierSchema = new Schema<IPriceTier>(
  {
    minQty: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const serviceSchema = new Schema<IService>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true },
    category: { type: String, enum: SERVICE_CATEGORIES, default: "autos" },
    description: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    price: { type: Number, required: true, min: 0 },
    priceMax: { type: Number, default: 0, min: 0 },
    unit: { type: String, enum: SERVICE_UNITS, default: "unidad" },
    durationMinutes: { type: Number, default: 60, min: 0 },
    durationLabel: { type: String, default: "" },
    deliveryNote: { type: String, default: "" },
    priceNote: { type: String, default: "" },
    features: { type: [String], default: [] },
    variants: { type: [variantSchema], default: [] },
    priceTiers: { type: [tierSchema], default: [] },
    minQty: { type: Number, default: 1, min: 0 },
    isExtra: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

export const Service = mongoose.model<IService>("Service", serviceSchema);
