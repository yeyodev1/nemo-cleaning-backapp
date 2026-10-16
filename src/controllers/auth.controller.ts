import { Request, Response } from "express";
import * as authService from "../services/auth.service";
import { AuthRequest } from "../types/AuthRequest";

export async function requestCode(req: Request, res: Response) {
  res.json(await authService.requestCode(req.body?.email));
}

export async function verify(req: Request, res: Response) {
  res.json(await authService.verifyCode(req.body?.email, req.body?.code));
}

export async function login(req: Request, res: Response) {
  res.json(await authService.loginWithPassword(req.body?.email, req.body?.password));
}

export async function resetPassword(req: Request, res: Response) {
  res.json(await authService.resetPassword(req.body?.email, req.body?.code, req.body?.password));
}

export async function me(req: AuthRequest, res: Response) {
  res.json(await authService.me(req.user!.id));
}
