import mongoose, { Schema, Document } from "mongoose";

export interface IBranch extends Document {
  name: string;
  slug: string;
  address: string;
  phone: string;
  whatsapp: string;
  email: string;
  active: boolean;
  openingTime: string;
  closingTime: string;
  slotMinutes: number;
  workDays: number[];
  /** Urbanizaciones / zonas que atiende (REP ZONA del Excel); editable desde el panel. */
  zones: string[];
  /** Registro de caja: desde qué día cuenta y con qué saldo arranca (centavos). */
  cashRegister?: { startDate: string; openingBalance: number };
}

/** El historial importado no registra las entregas de efectivo a gerencia: la caja arranca aquí. */
export const DEFAULT_CASH_START = "2026-10-01";

const branchSchema = new Schema<IBranch>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    address: { type: String, default: "" },
    phone: { type: String, default: "" },
    whatsapp: { type: String, default: "" },
    email: { type: String, default: "" },
    active: { type: Boolean, default: true },
    openingTime: { type: String, default: "08:00" },
    closingTime: { type: String, default: "18:00" },
    slotMinutes: { type: Number, default: 60, min: 15, max: 480 },
    // 0 = domingo. Por defecto lunes a sábado.
    workDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
    zones: { type: [String], default: undefined },
    cashRegister: {
      type: new Schema(
        {
          startDate: { type: String, default: DEFAULT_CASH_START },
          openingBalance: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true, versionKey: false },
);

export const Branch = mongoose.model<IBranch>("Branch", branchSchema);
