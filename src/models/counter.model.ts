import mongoose, { Schema } from "mongoose";

/**
 * Secuencias legibles (NEMO-000001, COT-000001). Un contador atómico por nombre
 * evita que dos pedidos simultáneos reciban el mismo código.
 */
interface ICounter {
  _id: string;
  seq: number;
}

const counterSchema = new Schema<ICounter>({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

export const Counter =
  mongoose.models.Counter || mongoose.model<ICounter>("Counter", counterSchema);

export async function nextSequence(name: string): Promise<number> {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  ).lean<ICounter>();
  return doc!.seq;
}

export async function nextCode(name: string, prefix: string): Promise<string> {
  const seq = await nextSequence(name);
  return `${prefix}-${String(seq).padStart(6, "0")}`;
}
