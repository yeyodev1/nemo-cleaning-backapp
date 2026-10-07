import mongoose, { Schema, Document, Types } from "mongoose";

/** Hoja "Calendario": ACTIVO / LIBRE / MEDIO DÍA por operador y día. */
export const SHIFT_STATUSES = ["active", "off", "half"] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

/** Medio día = solo turnos que empiezan antes de esta hora. */
export const HALF_DAY_UNTIL = "13:00";

export interface IShift extends Document {
  operator: Types.ObjectId;
  date: string;
  status: ShiftStatus;
  updatedBy?: { id: string; name: string };
}

const shiftSchema = new Schema<IShift>(
  {
    operator: { type: Schema.Types.ObjectId, ref: "User", required: true },
    date: { type: String, required: true },
    status: { type: String, enum: SHIFT_STATUSES, required: true },
    updatedBy: { type: new Schema({ id: String, name: String }, { _id: false }) },
  },
  { timestamps: true, versionKey: false },
);

// Un registro por operador y día; sin registro = ACTIVO (no rompe la agenda si no se llena).
shiftSchema.index({ operator: 1, date: 1 }, { unique: true });
shiftSchema.index({ date: 1 });

export const Shift = mongoose.model<IShift>("Shift", shiftSchema);
