import { Response } from "express";
import * as operatorJobService from "../services/operatorJob.service";
import { AuthRequest } from "../types/AuthRequest";

export async function myBookings(req: AuthRequest, res: Response) {
  res.json(await operatorJobService.myJobs(req.user!, req.query));
}

export async function changeStatus(req: AuthRequest, res: Response) {
  res.json(await operatorJobService.changeJobStatus(String(req.params.id), req.body, req.user!));
}

export async function addNovedad(req: AuthRequest, res: Response) {
  res.status(201).json(await operatorJobService.addJobNovedad(String(req.params.id), req.body, req.user!));
}
