import { Response } from "express";
import * as bookingService from "../services/booking.service";
import * as paymentService from "../services/payment.service";
import { AuthRequest } from "../types/AuthRequest";

export async function list(req: AuthRequest, res: Response) {
  res.json(await bookingService.listBookings(req.user!, req.query));
}

export async function agenda(req: AuthRequest, res: Response) {
  res.json(await bookingService.getAgenda(req.user!, req.query));
}

export async function create(req: AuthRequest, res: Response) {
  res.status(201).json(await bookingService.createAdminBooking(req.body, req.user!));
}

export async function detail(req: AuthRequest, res: Response) {
  res.json(await bookingService.getAdminBooking(String(req.params.id), req.user!));
}

export async function update(req: AuthRequest, res: Response) {
  res.json(await bookingService.updateAdminBooking(String(req.params.id), req.body, req.user!));
}

export async function changeStatus(req: AuthRequest, res: Response) {
  res.json(await bookingService.changeStatus(String(req.params.id), req.body, req.user!));
}

export async function addPayment(req: AuthRequest, res: Response) {
  res
    .status(201)
    .json(await paymentService.addManualPayment(String(req.params.id), req.body, req.user!));
}

export async function receivables(req: AuthRequest, res: Response) {
  res.json(await bookingService.listReceivables(req.user!, req.query));
}
