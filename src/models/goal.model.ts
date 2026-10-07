import mongoose, { Schema, Document, Types } from "mongoose";

/** Hoja "Metas Mensuales": meta de producción por operador y mes (centavos). */
export interface IGoal extends Document {
  operator: Types.ObjectId;
  month: string;
  amount: number;
  notes: string;
}

const goalSchema = new Schema<IGoal>(
  {
    operator: { type: Schema.Types.ObjectId, ref: "User", required: true },
    month: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    notes: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

goalSchema.index({ operator: 1, month: 1 }, { unique: true });
goalSchema.index({ month: 1 });

export const Goal = mongoose.model<IGoal>("Goal", goalSchema);
