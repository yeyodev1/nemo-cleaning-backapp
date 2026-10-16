import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * Novedades que no son de un servicio puntual: de una persona del equipo (llegó tarde, pelea)
 * o generales de la sucursal (un atraso, una inconsistencia en caja o en registros).
 */
export const STAFF_INCIDENT_TYPES = ["late", "absence", "fight", "customer_issue", "damage", "inconsistency", "complaint", "other"] as const;
export type StaffIncidentType = (typeof STAFF_INCIDENT_TYPES)[number];

export interface IStaffIncident extends Document {
  /** Persona involucrada; null = novedad general (de la sucursal). */
  user: Types.ObjectId | null;
  branch: Types.ObjectId | null;
  type: StaffIncidentType;
  /** Día en que pasó (YYYY-MM-DD, hora de Ecuador). */
  date: string;
  text: string;
  by: { id: string; name: string };
  createdAt: Date;
}

const staffIncidentSchema = new Schema<IStaffIncident>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    type: { type: String, enum: STAFF_INCIDENT_TYPES, required: true },
    date: { type: String, required: true },
    text: { type: String, default: "" },
    by: { type: new Schema({ id: String, name: String }, { _id: false }) },
  },
  { timestamps: true, versionKey: false },
);

staffIncidentSchema.index({ user: 1, date: -1 });
staffIncidentSchema.index({ date: -1 });

export const StaffIncident = mongoose.model<IStaffIncident>("StaffIncident", staffIncidentSchema);
