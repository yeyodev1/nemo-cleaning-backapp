import { Response } from "express";
import * as expenseService from "../services/expense.service";
import * as paymentService from "../services/payment.service";
import * as reportService from "../services/report.service";
import { AuthRequest } from "../types/AuthRequest";

export async function dashboard(req: AuthRequest, res: Response) {
  res.json(await reportService.dashboard(req.user!, req.query));
}

export async function listPayments(req: AuthRequest, res: Response) {
  res.json(await paymentService.listPayments(req.user!, req.query));
}

export async function reviewPayment(req: AuthRequest, res: Response) {
  res.json(await paymentService.reviewPayment(String(req.params.id), req.body, req.user!));
}

export async function listExpenses(req: AuthRequest, res: Response) {
  res.json(await expenseService.listExpenses(req.user!, req.query));
}

export async function createExpense(req: AuthRequest, res: Response) {
  res.status(201).json(await expenseService.createExpense(req.body, req.user!));
}

export async function updateExpense(req: AuthRequest, res: Response) {
  res.json(await expenseService.updateExpense(String(req.params.id), req.body, req.user!));
}

export async function deleteExpense(req: AuthRequest, res: Response) {
  res.json(
    await expenseService.deleteExpense(String(req.params.id), req.user!, req.query.scope),
  );
}

export async function incomeStatement(req: AuthRequest, res: Response) {
  res.json(await reportService.incomeStatement(req.user!, req.query));
}

export async function production(req: AuthRequest, res: Response) {
  res.json(await reportService.productionReport(req.user!, req.query));
}

export async function cash(req: AuthRequest, res: Response) {
  res.json(await reportService.cashReport(req.user!, req.query));
}
