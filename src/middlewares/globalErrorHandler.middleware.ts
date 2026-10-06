import { Request, Response, NextFunction } from "express";
import { MulterError } from "multer";
import { ErrorHandler } from "../errors/errorHandler.error";
import { env } from "../config/env";

export function globalErrorHandler(error: any, _req: Request, res: Response, _next: NextFunction) {
  const handler = new ErrorHandler(env.SLACK_ERROR_WEBHOOK);

  // Índice único de Mongo: es un 409 del cliente, no un 500 nuestro.
  if (error?.code === 11000) {
    const duplicatedField = Object.keys(error.keyValue || {})[0] || "campo";
    const duplicatedValue = error.keyValue?.[duplicatedField];
    res.status(409).json({
      message: duplicatedValue
        ? `Ya existe un registro con ${duplicatedField}: ${duplicatedValue}`
        : "Ya existe un registro con esos datos",
    });
    return;
  }

  if (error instanceof MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? "El archivo supera el tamaño máximo de 8 MB"
        : "No se pudo procesar el archivo";
    res.status(400).json({ message });
    return;
  }

  if (error?.name === "CastError") {
    res.status(400).json({ message: "Identificador inválido" });
    return;
  }

  if (error?.name === "ValidationError") {
    const first = Object.values(error.errors || {})[0] as any;
    res.status(400).json({ message: first?.message || "Datos inválidos" });
    return;
  }

  // JSON mal formado en el body.
  if (error?.type === "entity.parse.failed") {
    res.status(400).json({ message: "El cuerpo de la petición no es un JSON válido" });
    return;
  }

  if (error?.message === "Not allowed by CORS") {
    res.status(403).json({ message: "Origen no permitido por CORS" });
    return;
  }

  const status = error.status || 500;
  const message = status >= 500 && !error.status ? "Error interno del servidor" : error.message;

  handler.handleHttpError(res, message || "Error interno del servidor", status, error);
}
