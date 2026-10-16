import { Response } from "express";
import * as commissionService from "../services/commission.service";
import * as commissionEntryService from "../services/commissionEntry.service";
import * as goalService from "../services/goal.service";
import * as novedadService from "../services/novedad.service";
import * as productionService from "../services/production.service";
import * as shiftService from "../services/shift.service";
import { AuthRequest } from "../types/AuthRequest";

// Producción del día (la "Base" del Excel) y registro rápido
export async function productionOptions(req: AuthRequest, res: Response) {
  res.json(await productionService.productionOptions(req.user!));
}
export async function listProduction(req: AuthRequest, res: Response) {
  res.json(await productionService.listProduction(req.user!, req.query));
}
export async function registerProduction(req: AuthRequest, res: Response) {
  res.status(201).json(await productionService.registerProduction(req.body, req.user!));
}
export async function setConfirmation(req: AuthRequest, res: Response) {
  res.json(await productionService.setConfirmation(String(req.params.id), req.body, req.user!));
}

// Novedades
export async function listNovedades(req: AuthRequest, res: Response) {
  res.json(await novedadService.listNovedades(req.user!, req.query));
}
export async function addNovedad(req: AuthRequest, res: Response) {
  res.status(201).json(await novedadService.addNovedad(String(req.params.id), req.body, req.user!));
}
export async function deleteNovedad(req: AuthRequest, res: Response) {
  res.json(await novedadService.deleteNovedad(String(req.params.id), String(req.params.nid), req.user!));
}

// Turnos
export async function monthShifts(req: AuthRequest, res: Response) {
  res.json(await shiftService.monthShifts(req.user!, req.query));
}
export async function saveShifts(req: AuthRequest, res: Response) {
  res.json(await shiftService.saveShifts(req.user!, req.body));
}

// Metas
export async function monthGoals(req: AuthRequest, res: Response) {
  res.json(await goalService.monthGoals(req.user!, req.query));
}
export async function saveGoal(req: AuthRequest, res: Response) {
  res.json(await goalService.saveGoal(req.user!, req.body));
}
export async function copyGoals(req: AuthRequest, res: Response) {
  res.json(await goalService.copyGoals(req.user!, req.body));
}

// Comisiones (FEE)
export async function commissionEntries(req: AuthRequest, res: Response) {
  res.json(await commissionEntryService.yearGrid(req.user!, req.query));
}
export async function saveCommissionEntry(req: AuthRequest, res: Response) {
  res.json(await commissionEntryService.saveEntry(req.user!, req.body));
}
export async function removeCommissionRow(req: AuthRequest, res: Response) {
  res.json(await commissionEntryService.removeRow(req.user!, req.body));
}
export async function commissionSheet(req: AuthRequest, res: Response) {
  res.json(await commissionService.monthSheet(req.user!, req.query));
}
export async function commissionGoalSheet(req: AuthRequest, res: Response) {
  res.json(await commissionService.goalSheet(req.user!, req.query));
}
export async function commissionRule(_req: AuthRequest, res: Response) {
  res.json(await commissionService.getRuleView());
}
export async function updateCommissionRule(req: AuthRequest, res: Response) {
  res.json(await commissionService.updateRule(req.body));
}
export async function addAdjustment(req: AuthRequest, res: Response) {
  res.status(201).json(await commissionService.addAdjustment(req.body, req.user!));
}
export async function deleteAdjustment(req: AuthRequest, res: Response) {
  res.json(await commissionService.deleteAdjustment(String(req.params.id), req.user!));
}
