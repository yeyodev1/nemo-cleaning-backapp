import mongoose, { Schema, Document, Types } from "mongoose";

/** Tipos de novedad del personal (lo que pasa con la persona, no con un servicio). */
export const STAFF_INCIDENT_TYPES = ["late", "absence", "fight", "customer_issue", "damage", "other"] as const;
export type StaffIncidentType = (typeof STAFF_INCIDENT_TYPES)[number];

export interface IStaffIncident extends Document {
  user: Types.ObjectId;
  type: StaffIncidentType;
  /** Día en que pasó (YYYY-MM-DD, hora de Ecuador). */
  date: string;
  text: string;
  by: { id: string; name: string };
  createdAt: Date;
}

const staffIncidentSchema = new Schema<IStaffIncident>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
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
