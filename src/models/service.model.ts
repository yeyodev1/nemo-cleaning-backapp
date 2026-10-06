import mongoose, { Schema, Document } from "mongoose";

export const SERVICE_CATEGORIES = [
  "vehiculos",
  "colchones",
  "muebles",
  "hogar",
  "alfombras",
  "oficinas",
  "otros",
] as const;
export const SERVICE_UNITS = ["unidad", "m2", "servicio"] as const;

export interface IService extends Document {
  name: string;
  slug: string;
  category: (typeof SERVICE_CATEGORIES)[number];
  description: string;
  imageUrl: string;
  price: number;
  unit: (typeof SERVICE_UNITS)[number];
  durationMinutes: number;
  isExtra: boolean;
  active: boolean;
  order: number;
}

const serviceSchema = new Schema<IService>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true },
    category: { type: String, enum: SERVICE_CATEGORIES, default: "otros" },
    description: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    price: { type: Number, required: true, min: 0 },
    unit: { type: String, enum: SERVICE_UNITS, default: "unidad" },
    durationMinutes: { type: Number, default: 60, min: 0 },
    isExtra: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

export const Service = mongoose.model<IService>("Service", serviceSchema);
