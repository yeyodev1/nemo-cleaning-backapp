export class CustomError extends Error {
  status: number;
  details?: unknown;
  /** Código estable para que el frontend reaccione sin comparar el texto del mensaje. */
  errorCode?: string;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
    this.name = "CustomError";
  }

  withCode(errorCode: string): this {
    this.errorCode = errorCode;
    return this;
  }
}
