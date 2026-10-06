import { Response } from "express";
import * as bookingService from "../services/booking.service";
import { AuthRequest } from "../types/AuthRequest";

export async function myBookings(req: AuthRequest, res: Response) {
  res.json(await bookingService.listOperatorBookings(req.user!, req.query));
}

export async function changeStatus(req: AuthRequest, res: Response) {
  res.json(await bookingService.operatorChangeStatus(String(req.params.id), req.body, req.user!));
}
