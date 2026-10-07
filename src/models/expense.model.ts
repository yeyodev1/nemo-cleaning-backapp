import mongoose, { Schema, Document, Types } from "mongoose";

export const EXPENSE_CATEGORIES = [
  "insumos",
  "sueldos",
  "transporte",
  "servicios_basicos",
  "arriendo",
  "mantenimiento",
  "marketing",
  "impuestos",
  "otros",
  // Fase 2: categorías reales de las hojas AGOSTO/SEPTIEMBRE y Gastos Variables/Fijos del Excel.
  "combustible",
  "quimicos",
  "anticipos",
  "usuarios_adicionales",
  "importaciones",
  "productos_importados",
  "recargas",
  "propinas",
  "internet",
  "luz",
  "agua",
  "gastos_mecanicos",
  "rodapies",
  "reparaciones",
  "uniformes",
  "imprevistos",
] as const;
export const PAID_FROM = ["petty_cash", "management"] as const;
export const EXPENSE_KINDS = ["variable", "fixed"] as const;
/** Categorías que nacen como gasto fijo (el resto, variable), igual que la hoja "Gastos Fijos". */
export const FIXED_BY_DEFAULT = ["arriendo"];

export interface IExpense extends Document {
  branch: Types.ObjectId | null;
  date: string;
  category: (typeof EXPENSE_CATEGORIES)[number];
  description: string;
  amount: number;
  paymentMethod: "cash" | "transfer" | "card";
  paidFrom: (typeof PAID_FROM)[number];
  supplier: string;
  receiptUrl: string;
  createdBy?: { id: string; name: string };
  /** Fijo (alquiler…) o variable: separa las filas del estado de resultados. */
  kind: (typeof EXPENSE_KINDS)[number];
  /** Gasto fijo que se repite cada mes con "Repetir gastos fijos". */
  recurring: boolean;
  /** Une las copias de un gasto recurrente o las cuotas de un diferido. */
  seriesKey: string;
  /** Diferido: cuota n de N sobre un monto total ("Diferido moto 10/12"). */
  installment?: { number: number; count: number; totalAmount: number } | null;
  /** Anticipos: a quién se le adelantó (descuenta en Nómina). */
  employee?: Types.ObjectId | null;
  createdAt: Date;
}

const expenseSchema = new Schema<IExpense>(
  {
    // null = gasto general de la empresa (solo gerencia).
    branch: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    date: { type: String, required: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, default: "otros" },
    description: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    paymentMethod: { type: String, enum: ["cash", "transfer", "card"], default: "cash" },
    paidFrom: { type: String, enum: PAID_FROM, default: "petty_cash" },
    supplier: { type: String, default: "" },
    receiptUrl: { type: String, default: "" },
    createdBy: { type: new Schema({ id: String, name: String }, { _id: false }) },
    kind: { type: String, enum: EXPENSE_KINDS, default: "variable" },
    recurring: { type: Boolean, default: false },
    seriesKey: { type: String, default: "" },
    installment: {
      type: new Schema(
        { number: Number, count: Number, totalAmount: Number },
        { _id: false },
      ),
      default: null,
    },
    employee: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, versionKey: false },
);

expenseSchema.index({ date: -1 });
expenseSchema.index({ branch: 1, date: -1 });
expenseSchema.index({ seriesKey: 1 });

export const Expense = mongoose.model<IExpense>("Expense", expenseSchema);
