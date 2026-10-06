import { isValidObjectId, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { SessionUser } from "../types/AuthRequest";

/**
 * Filtro de sucursal según el rol: el admin ve todo (o la sucursal pedida) y el
 * manager solo las suyas. Pedir una sucursal ajena es un 403, no una lista vacía,
 * para que el panel no muestre "sin datos" donde en realidad no hay permiso.
 */
export function branchFilter(user: SessionUser, requested?: unknown): Record<string, any> {
  if (requested !== undefined && requested !== "" && requested !== null) {
    if (typeof requested !== "string" || !isValidObjectId(requested)) {
      throw new CustomError("Sucursal inválida", 400);
    }
    assertBranchAccess(user, requested);
    return { branch: new Types.ObjectId(requested) };
  }
  if (user.role === "admin") return {};
  return { branch: { $in: user.branches.map((b) => new Types.ObjectId(b)) } };
}

export function assertBranchAccess(user: SessionUser, branchId: unknown): void {
  if (user.role === "admin") return;
  if (!branchId || !user.branches.includes(String(branchId))) {
    throw new CustomError("No tienes acceso a esta sucursal", 403);
  }
}

export function actor(user?: SessionUser): { id: string; name: string } | undefined {
  return user ? { id: user.id, name: user.name || user.email } : undefined;
}
