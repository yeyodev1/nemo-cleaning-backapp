import mongoose, { Schema, Document, Types } from "mongoose";

/** Categorías de la hoja "Pagos Quincenales" (validación de datos de la columna Categoría). */
export const PAYABLE_CATEGORIES = [
  "nomina",
  "comision",
  "proveedor",
  "servicios",
  "alquiler",
  "credito",
  "marketing",
  "reembolso",
  "impuestos",
  "otro",
] as const;
export const PAYABLE_METHODS = ["transfer", "cash", "card", "deposit", "check", "other"] as const;

/**
 * "Pagos por realizar": checklist de obligaciones por mes y quincena. El estado sale de lo
 * pagado (pendiente / parcial / pagado) para que no se contradiga con los montos.
 */
export interface IPayable extends Document {
  branch: Types.ObjectId | null;
  month: string;
  fortnight: 1 | 2;
  dueDate: string;
  beneficiary: string;
  category: (typeof PAYABLE_CATEGORIES)[number];
  amount: number;
  paidAmount: number;
  status: "pending" | "partial" | "paid";
  paidDate: string;
  method: (typeof PAYABLE_METHODS)[number] | "";
  account: string;
  reference: string;
  notes: string;
  createdBy?: { id: string; name: string };
  createdAt: Date;
}

const payableSchema = new Schema<IPayable>(
  {
    // null = pago general de la empresa (no de una sucursal).
    branch: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    month: { type: String, required: true },
    fortnight: { type: Number, enum: [1, 2], required: true },
    dueDate: { type: String, default: "" },
    beneficiary: { type: String, required: true, trim: true },
    category: { type: String, enum: PAYABLE_CATEGORIES, default: "otro" },
    amount: { type: Number, required: true, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ["pending", "partial", "paid"], default: "pending" },
    paidDate: { type: String, default: "" },
    method: { type: String, enum: [...PAYABLE_METHODS, ""], default: "" },
    account: { type: String, default: "" },
    reference: { type: String, default: "" },
    notes: { type: String, default: "" },
    createdBy: { type: new Schema({ id: String, name: String }, { _id: false }) },
  },
  { timestamps: true, versionKey: false },
);

payableSchema.index({ month: 1, fortnight: 1, branch: 1 });

export const Payable = mongoose.model<IPayable>("Payable", payableSchema);
