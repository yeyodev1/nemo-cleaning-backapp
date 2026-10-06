import { Request, Response } from "express";
import * as availabilityService from "../services/availability.service";
import * as bookingService from "../services/booking.service";
import * as branchService from "../services/branch.service";
import * as catalogService from "../services/catalog.service";
import * as cloudinaryService from "../services/cloudinary.service";
import * as officeQuoteService from "../services/officeQuote.service";
import * as payphoneService from "../services/payphone.service";
import * as pricingService from "../services/pricing.service";
import * as settingsService from "../services/settings.service";

export async function branches(_req: Request, res: Response) {
  res.json(await branchService.listPublicBranches());
}

export async function services(req: Request, res: Response) {
  res.json(await catalogService.listPublicServices(req.query));
}

export async function settings(_req: Request, res: Response) {
  res.json(await settingsService.getPublicSettings());
}

export async function availability(req: Request, res: Response) {
  res.json(await availabilityService.getAvailability(req.query.branch, req.query.date));
}

export async function quote(req: Request, res: Response) {
  res.json(await pricingService.quote(req.body));
}

export async function createBooking(req: Request, res: Response) {
  res.status(201).json(await bookingService.createPublicBooking(req.body));
}

export async function getBooking(req: Request, res: Response) {
  res.json(await bookingService.getPublicBooking(req.params.code, req.query.token));
}

export async function transferProof(req: Request, res: Response) {
  res.json(await bookingService.uploadTransferProof(req.params.code, req.query.token, req.file));
}

export async function cancelBooking(req: Request, res: Response) {
  res.json(
    await bookingService.cancelPublicBooking(req.params.code, req.query.token, req.body?.reason),
  );
}

export async function restartPayphone(req: Request, res: Response) {
  res.json(await bookingService.restartPayphone(req.params.code, req.query.token));
}

export async function confirmPayphone(req: Request, res: Response) {
  res.json(await payphoneService.confirmPayphone(req.body));
}

export async function createOfficeQuote(req: Request, res: Response) {
  res.status(201).json(await officeQuoteService.createOfficeQuote(req.body));
}

export async function uploadProof(req: Request, res: Response) {
  res.status(201).json(await cloudinaryService.uploadFile(req.file, "comprobantes"));
}
