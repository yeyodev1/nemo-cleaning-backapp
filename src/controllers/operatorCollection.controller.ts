import { Response } from "express";
import * as collectionService from "../services/operatorCollection.service";
import { AuthRequest } from "../types/AuthRequest";

export async function list(req: AuthRequest, res: Response) {
  res.json(await collectionService.listCollections(req.user!, req.query));
}

export async function receive(req: AuthRequest, res: Response) {
  res.json(await collectionService.receiveCollection(String(req.params.id), req.body, req.user!));
}

export async function pending(req: AuthRequest, res: Response) {
  res.json(await collectionService.pendingCount(req.user!));
}
