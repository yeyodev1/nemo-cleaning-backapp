import { Response } from "express";
import * as customerService from "../services/customer.service";
import * as userService from "../services/user.service";
import { AuthRequest } from "../types/AuthRequest";

export async function listCustomers(req: AuthRequest, res: Response) {
  res.json(await customerService.listCustomers(req.query));
}
export async function getCustomer(req: AuthRequest, res: Response) {
  res.json(await customerService.getCustomer(String(req.params.id), req.user!));
}
export async function createCustomer(req: AuthRequest, res: Response) {
  res.status(201).json(await customerService.createCustomer(req.body));
}
export async function updateCustomer(req: AuthRequest, res: Response) {
  res.json(await customerService.updateCustomer(String(req.params.id), req.body));
}

export async function listUsers(req: AuthRequest, res: Response) {
  res.json(await userService.listUsers(req.user!, req.query));
}
export async function getUser(req: AuthRequest, res: Response) {
  res.json(await userService.getUser(String(req.params.id)));
}
export async function createUser(req: AuthRequest, res: Response) {
  res.status(201).json(await userService.createUser(req.body));
}
export async function updateUser(req: AuthRequest, res: Response) {
  res.json(await userService.updateUser(String(req.params.id), req.body, req.user!));
}
