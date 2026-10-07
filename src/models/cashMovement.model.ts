import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * Movimientos MANUALES del registro de caja (los cobros en efectivo y los gastos de caja
 * menor entran solos desde Payment y Expense). Conceptos de la hoja "Registro de caja".
 */
export const CASH_CONCEPTS = [
  "opening",
  "tip_cash",
  "to_management",
  "from_management",
  "adjustment",
  "other",
] as const;

export interface ICashMovement extends Document {
  branch: Types.ObjectId;
  date: string;
  direction: "in" | "out";
  concept: (typeof CASH_CONCEPTS)[number];
  amount: number;
  operator: Types.ObjectId | null;
  detail: string;
  createdBy?: { id: string; name: string };
  createdAt: Date;
}

const cashMovementSchema = new Schema<ICashMovement>(
  {
    branch: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    date: { type: String, required: true },
    direction: { type: String, enum: ["in", "out"], required: true },
    concept: { type: String, enum: CASH_CONCEPTS, default: "other" },
    amount: { type: Number, required: true, min: 1 },
    operator: { type: Schema.Types.ObjectId, ref: "User", default: null },
    detail: { type: String, default: "" },
    createdBy: { type: new Schema({ id: String, name: String }, { _id: false }) },
  },
  { timestamps: true, versionKey: false },
);

cashMovementSchema.index({ branch: 1, date: 1 });

export const CashMovement = mongoose.model<ICashMovement>("CashMovement", cashMovementSchema);
