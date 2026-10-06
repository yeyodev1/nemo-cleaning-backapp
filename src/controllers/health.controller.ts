import { Request, Response } from "express";
import { isConnected } from "../config/mongo";

export function health(_req: Request, res: Response) {
  res.json({ ok: true, db: isConnected() });
}
