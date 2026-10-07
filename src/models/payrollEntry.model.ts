import mongoose, { Schema, Document, Types } from "mongoose";

export interface IPayrollPayment {
  paid: number;
  date: string;
  method: string;
  reference: string;
}

/**
 * Una fila de "Nómina Quincenal": sueldo del mes de un colaborador y lo pagado en cada
 * quincena. El sueldo se copia del Personal al crear la fila y se puede editar por mes
 * (así un cambio de sueldo no reescribe meses pasados).
 */
export interface IPayrollEntry extends Document {
  month: string;
  user: Types.ObjectId;
  name: string;
  position: string;
  branch: Types.ObjectId | null;
  salary: number;
  q1: IPayrollPayment;
  q2: IPayrollPayment;
  notes: string;
  createdAt: Date;
}

const paySchema = {
  type: new Schema(
    {
      paid: { type: Number, default: 0, min: 0 },
      date: { type: String, default: "" },
      method: { type: String, default: "" },
      reference: { type: String, default: "" },
    },
    { _id: false },
  ),
  default: () => ({}),
};

const payrollSchema = new Schema<IPayrollEntry>(
  {
    month: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, default: "" },
    position: { type: String, default: "" },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    salary: { type: Number, default: 0, min: 0 },
    q1: paySchema,
    q2: paySchema,
    notes: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

payrollSchema.index({ month: 1, user: 1 }, { unique: true });

export const PayrollEntry = mongoose.model<IPayrollEntry>("PayrollEntry", payrollSchema);
