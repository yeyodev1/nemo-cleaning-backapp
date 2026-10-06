import { Response } from "express";
import * as officeQuoteService from "../services/officeQuote.service";
import { AuthRequest } from "../types/AuthRequest";

export async function list(req: AuthRequest, res: Response) {
  res.json(await officeQuoteService.listOfficeQuotes(req.user!, req.query));
}
export async function detail(req: AuthRequest, res: Response) {
  res.json(await officeQuoteService.getOfficeQuote(String(req.params.id), req.user!));
}
export async function update(req: AuthRequest, res: Response) {
  res.json(await officeQuoteService.updateOfficeQuote(String(req.params.id), req.body, req.user!));
}
export async function convert(req: AuthRequest, res: Response) {
  res
    .status(201)
    .json(await officeQuoteService.convertOfficeQuote(String(req.params.id), req.body, req.user!));
}
