import { Response } from "express";
import * as annual from "../services/annualReport.service";
import * as bank from "../services/bankReconciliation.service";
import * as cash from "../services/cashRegister.service";
import * as commercial from "../services/commercial.service";
import * as expenses from "../services/expense.service";
import * as fortnight from "../services/fortnightReport.service";
import * as payables from "../services/payable.service";
import * as payroll from "../services/payroll.service";
import * as aging from "../services/receivablesAging.service";
import { AuthRequest } from "../types/AuthRequest";

/** Finanzas y gestión (fase 2): reportes del Excel de gerencia y producción. */

const id = (req: AuthRequest) => String(req.params.id);

export async function fortnightReport(req: AuthRequest, res: Response) {
  res.json(await fortnight.fortnightReport(req.user!, req.query));
}
export async function annualStatement(req: AuthRequest, res: Response) {
  res.json(await annual.annualStatement(req.user!, req.query));
}
export async function monthlyDetail(req: AuthRequest, res: Response) {
  res.json(await annual.monthlyDetail(req.user!, req.query));
}

export async function repeatFixed(req: AuthRequest, res: Response) {
  res.json(await expenses.repeatFixed(req.user!, req.body));
}

export async function listPayables(req: AuthRequest, res: Response) {
  res.json(await payables.listPayables(req.user!, req.query));
}
export async function createPayable(req: AuthRequest, res: Response) {
  res.status(201).json(await payables.createPayable(req.body, req.user!));
}
export async function updatePayable(req: AuthRequest, res: Response) {
  res.json(await payables.updatePayable(id(req), req.body, req.user!));
}
export async function deletePayable(req: AuthRequest, res: Response) {
  res.json(await payables.deletePayable(id(req), req.user!));
}
export async function copyPayables(req: AuthRequest, res: Response) {
  res.json(await payables.copyPayables(req.body, req.user!));
}

export async function listPayroll(req: AuthRequest, res: Response) {
  res.json(await payroll.listPayroll(req.user!, req.query));
}
export async function addPayroll(req: AuthRequest, res: Response) {
  res.status(201).json(await payroll.addPayroll(req.body, req.user!));
}
export async function updatePayroll(req: AuthRequest, res: Response) {
  res.json(await payroll.updatePayroll(id(req), req.body, req.user!));
}
export async function deletePayroll(req: AuthRequest, res: Response) {
  res.json(await payroll.deletePayroll(id(req), req.user!));
}

export async function cashRegister(req: AuthRequest, res: Response) {
  res.json(await cash.cashRegister(req.user!, req.query));
}
export async function createMovement(req: AuthRequest, res: Response) {
  res.status(201).json(await cash.createMovement(req.body, req.user!));
}
export async function updateMovement(req: AuthRequest, res: Response) {
  res.json(await cash.updateMovement(id(req), req.body, req.user!));
}
export async function deleteMovement(req: AuthRequest, res: Response) {
  res.json(await cash.deleteMovement(id(req), req.user!));
}

export async function receivablesAging(req: AuthRequest, res: Response) {
  res.json(await aging.receivablesAging(req.user!, req.query));
}

export async function bankReconciliation(req: AuthRequest, res: Response) {
  res.json(await bank.bankReconciliation(req.user!, req.query));
}
export async function verifyPayment(req: AuthRequest, res: Response) {
  res.json(await bank.verifyPayment(id(req), req.body, req.user!));
}
export async function saveStatement(req: AuthRequest, res: Response) {
  res.json(await bank.saveStatement(req.body, req.user!));
}

export async function zones(req: AuthRequest, res: Response) {
  res.json(await commercial.zoneReport(req.user!, req.query));
}
export async function frequency(req: AuthRequest, res: Response) {
  res.json(await commercial.frequencyReport(req.user!, req.query));
}
export async function portfolio(req: AuthRequest, res: Response) {
  res.json(await commercial.portfolio(req.user!, req.query));
}
export async function updateFollowUp(req: AuthRequest, res: Response) {
  res.json(await commercial.updateFollowUp(id(req), req.body, req.user!));
}
