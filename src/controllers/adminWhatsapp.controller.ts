import { Response } from "express";
import * as whatsappService from "../services/whatsapp.service";
import { AuthRequest } from "../types/AuthRequest";

// Pedidos por WhatsApp: bandeja, búsqueda por código, cliente por teléfono y pedido rápido.
export async function inbox(req: AuthRequest, res: Response) {
  res.json(await whatsappService.inbox(req.user!, req.query));
}
export async function count(req: AuthRequest, res: Response) {
  res.json(await whatsappService.pendingCount(req.user!, req.query));
}
export async function lookup(req: AuthRequest, res: Response) {
  res.json(await whatsappService.lookupByCode(req.user!, req.query.code));
}
export async function customer(req: AuthRequest, res: Response) {
  res.json(await whatsappService.customerByPhone(req.user!, req.query.phone));
}
export async function createOrder(req: AuthRequest, res: Response) {
  res.status(201).json(await whatsappService.createQuickOrder(req.body, req.user!));
}
export async function handleOrder(req: AuthRequest, res: Response) {
  res.json(await whatsappService.handleOrder(String(req.params.id), req.body, req.user!));
}
