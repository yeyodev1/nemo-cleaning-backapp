import { CustomError } from "../errors/customError.error";
import { isValidTime } from "./date";
export { assertObjectId, slugify, str } from "./http";

export function isValidTimeOrThrow(value: unknown, label: string): string {
  if (!isValidTime(value)) throw new CustomError(`${label} debe tener el formato HH:mm`, 400);
  return value;
}
