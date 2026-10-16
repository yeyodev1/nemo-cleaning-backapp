import { Response } from "express";
import * as staffIncidentService from "../services/staffIncident.service";
import { AuthRequest } from "../types/AuthRequest";

export async function list(req: AuthRequest, res: Response) {
  res.json(await staffIncidentService.listStaffIncidents(req.user!, req.query));
}

export async function create(req: AuthRequest, res: Response) {
  res.status(201).json(await staffIncidentService.createStaffIncident(req.user!, req.body));
}

export async function remove(req: AuthRequest, res: Response) {
  res.json(await staffIncidentService.deleteStaffIncident(req.user!, String(req.params.id)));
}
