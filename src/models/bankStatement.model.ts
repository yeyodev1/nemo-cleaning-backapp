import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * Lo que dice el banco para una cuenta en un periodo (semana o quincena): se compara con
 * los pagos registrados con esa cuenta en la conciliación bancaria.
 */
export interface IBankStatement extends Document {
  account: string;
  branch: Types.ObjectId | null;
  from: string;
  to: string;
  amount: number;
  note: string;
  /** Archivo del estado de cuenta (PDF o imagen en Cloudinary) para descargarlo después. */
  fileUrl: string;
  updatedBy?: { id: string; name: string };
}

const bankStatementSchema = new Schema<IBankStatement>(
  {
    account: { type: String, required: true },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    from: { type: String, required: true },
    to: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, default: "" },
    fileUrl: { type: String, default: "" },
    updatedBy: { type: new Schema({ id: String, name: String }, { _id: false }) },
  },
  { timestamps: true, versionKey: false },
);

bankStatementSchema.index({ account: 1, branch: 1, from: 1, to: 1 }, { unique: true });

export const BankStatement = mongoose.model<IBankStatement>("BankStatement", bankStatementSchema);
