import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * Hoja "Comisiones" del Excel: lo que gerencia escribe a mano por colaborador y mes.
 * Es la fuente de las comisiones del estado de resultados (el FEE calculado queda solo
 * como referencia). El colaborador puede ser alguien del Personal (`user`) o un nombre libre.
 */
export interface ICommissionEntry extends Document {
  branch: Types.ObjectId;
  user: Types.ObjectId | null;
  name: string;
  position: string;
  month: string;
  amount: number;
  note: string;
  /** Identidad de la fila: `u:<userId>` o `n:<nombre normalizado>`. */
  rowKey: string;
  updatedBy?: { id: string; name: string };
  importBatch?: string;
  createdAt: Date;
}

const commissionEntrySchema = new Schema<ICommissionEntry>(
  {
    branch: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, required: true, trim: true },
    position: { type: String, default: "" },
    month: { type: String, required: true },
    // Centavos; puede ser negativo si se descuenta algo ese mes.
    amount: { type: Number, required: true },
    note: { type: String, default: "" },
    rowKey: { type: String, required: true },
    updatedBy: { type: new Schema({ id: String, name: String }, { _id: false }) },
    importBatch: { type: String },
  },
  { timestamps: true, versionKey: false },
);

commissionEntrySchema.index({ branch: 1, month: 1, rowKey: 1 }, { unique: true });
commissionEntrySchema.index({ month: 1 });

export const CommissionEntry = mongoose.model<ICommissionEntry>("CommissionEntry", commissionEntrySchema);
