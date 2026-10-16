import mongoose, { Schema, Document, Types } from "mongoose";

export const ROLES = ["admin", "manager", "operator"] as const;
/** Cargos reales del Excel (Metas Mensuales / Nómina). */
export const POSITIONS = ["supervisor", "base_assistant", "washer"] as const;

export interface IUser extends Document {
  name: string;
  email: string;
  phone: string;
  /** Hash scrypt (`utils/password`) para entrar con contraseña; también se puede entrar por código. */
  password?: string;
  role: (typeof ROLES)[number];
  branches: Types.ObjectId[];
  active: boolean;
  color: string;
  /** Cargo: Supervisor, Asistente de base o Lavador ("" = sin cargo). */
  position: (typeof POSITIONS)[number] | "";
  /** Sueldo mensual en centavos (base de la nómina). */
  monthlySalary: number;
  /** Gana FEE diario (comisión por excedente). */
  commissions: boolean;
  /** Quién cobra el "FEE supervisor" de este operador. */
  supervisor: Types.ObjectId | null;
  lastLoginAt?: Date;
  /** Lote de importación del Excel histórico (permite deshacerla). */
  importBatch?: string;
  createdAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    // Opcional: muchos lavadores no entran al panel. Único solo cuando existe (índice parcial abajo).
    email: { type: String, default: "", lowercase: true, trim: true },
    phone: { type: String, default: "" },
    password: { type: String, select: false },
    role: { type: String, enum: ROLES, default: "operator" },
    branches: [{ type: Schema.Types.ObjectId, ref: "Branch" }],
    active: { type: Boolean, default: true },
    color: { type: String, default: "#19C3B8" },
    position: { type: String, enum: [...POSITIONS, ""], default: "" },
    monthlySalary: { type: Number, default: 0, min: 0 },
    commissions: { type: Boolean, default: true },
    supervisor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    lastLoginAt: { type: Date },
    importBatch: { type: String },
  },
  { timestamps: true, versionKey: false },
);

userSchema.index(
  { email: 1 },
  { name: "email_unique_when_set", unique: true, partialFilterExpression: { email: { $gt: "" } } },
);

/**
 * El índice viejo `email_1` era único para todos: con varios lavadores sin correo
 * chocaría. Se reemplaza por el parcial una sola vez (idempotente, corre en el arranque).
 */
export async function ensureUserEmailIndex(): Promise<void> {
  const indexes = await User.collection.indexes().catch(() => []);
  if (indexes.some((i) => i.name === "email_1")) await User.collection.dropIndex("email_1");
  await User.createIndexes();
}

export const User = mongoose.model<IUser>("User", userSchema);
