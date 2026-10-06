import { Response } from "express";
import * as branchService from "../services/branch.service";
import * as catalogService from "../services/catalog.service";
import * as cloudinaryService from "../services/cloudinary.service";
import * as settingsService from "../services/settings.service";
import { AuthRequest } from "../types/AuthRequest";

export async function listServices(req: AuthRequest, res: Response) {
  res.json(await catalogService.listServices(req.query));
}
export async function getService(req: AuthRequest, res: Response) {
  res.json(await catalogService.getService(String(req.params.id)));
}
export async function createService(req: AuthRequest, res: Response) {
  res.status(201).json(await catalogService.createService(req.body));
}
export async function updateService(req: AuthRequest, res: Response) {
  res.json(await catalogService.updateService(String(req.params.id), req.body));
}
export async function deleteService(req: AuthRequest, res: Response) {
  res.json(await catalogService.deactivateService(String(req.params.id)));
}

export async function listBranches(req: AuthRequest, res: Response) {
  res.json(await branchService.listBranches(req.user!));
}
export async function getBranch(req: AuthRequest, res: Response) {
  res.json(await branchService.getBranch(String(req.params.id)));
}
export async function createBranch(req: AuthRequest, res: Response) {
  res.status(201).json(await branchService.createBranch(req.body));
}
export async function updateBranch(req: AuthRequest, res: Response) {
  res.json(await branchService.updateBranch(String(req.params.id), req.body));
}

export async function getSettings(_req: AuthRequest, res: Response) {
  res.json(await settingsService.getAdminSettings());
}
export async function updateSettings(req: AuthRequest, res: Response) {
  res.json(await settingsService.updateSettings(req.body));
}

export async function upload(req: AuthRequest, res: Response) {
  res.status(201).json(await cloudinaryService.uploadFile(req.file, "panel"));
}
