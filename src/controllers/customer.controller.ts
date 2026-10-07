import { Request, Response } from "express";
import * as customerAccountService from "../services/customerAccount.service";
import * as customerAuthService from "../services/customerAuth.service";
import { CustomerRequest } from "../types/AuthRequest";

export async function requestCode(req: Request, res: Response) {
  res.json(await customerAuthService.requestCode(req.body?.email));
}

export async function verify(req: Request, res: Response) {
  res.json(await customerAuthService.verifyCode(req.body?.email, req.body?.code));
}

export async function me(req: CustomerRequest, res: Response) {
  res.json(await customerAccountService.getMe(req.customer!.id));
}

export async function updateMe(req: CustomerRequest, res: Response) {
  res.json(await customerAccountService.updateMe(req.customer!.id, req.body));
}

export async function bookings(req: CustomerRequest, res: Response) {
  res.json(await customerAccountService.listBookings(req.customer!.id, req.query));
}
