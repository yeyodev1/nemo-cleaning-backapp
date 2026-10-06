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
] as const;
export const PAID_FROM = ["petty_cash", "management"] as const;

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
  },
  { timestamps: true, versionKey: false },
);

expenseSchema.index({ date: -1 });
expenseSchema.index({ branch: 1, date: -1 });

export const Expense = mongoose.model<IExpense>("Expense", expenseSchema);
