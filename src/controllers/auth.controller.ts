import { Request, Response } from "express";
import * as authService from "../services/auth.service";
import { AuthRequest } from "../types/AuthRequest";

export async function login(req: Request, res: Response) {
  res.json(await authService.login(req.body?.email, req.body?.password));
}

export async function me(req: AuthRequest, res: Response) {
  res.json(await authService.me(req.user!.id));
}

export async function changePassword(req: AuthRequest, res: Response) {
  res.json(
    await authService.changePassword(
      req.user!.id,
      req.body?.currentPassword,
      req.body?.newPassword,
    ),
  );
}
