import express from "express";
import * as bookingController from "../controllers/adminBooking.controller";
import * as catalogController from "../controllers/adminCatalog.controller";
import * as financeController from "../controllers/adminFinance.controller";
import * as officeQuoteController from "../controllers/adminOfficeQuote.controller";
import * as peopleController from "../controllers/adminPeople.controller";
import operationRoutes from "./adminOperation.routes";
import { requireRoles } from "../middlewares/auth.middleware";
import { uploadMiddleware } from "../middlewares/upload.middleware";
import { commercialRoutes, financeRoutes } from "./adminAccounting.routes";

/** authMiddleware ya corrió en routes/index.ts; aquí van los gates de rol. */
const router = express.Router();
const staff = requireRoles("admin", "manager");
const admin = requireRoles("admin");
const any = requireRoles("admin", "manager", "operator");

router.get("/dashboard", staff, financeController.dashboard);

// Pedidos y agenda
router.get("/bookings", staff, bookingController.list);
router.post("/bookings", staff, bookingController.create);
router.get("/bookings/:id", staff, bookingController.detail);
router.patch("/bookings/:id", staff, bookingController.update);
router.patch("/bookings/:id/status", staff, bookingController.changeStatus);
router.post("/bookings/:id/payments", staff, bookingController.addPayment);
router.get("/agenda", staff, bookingController.agenda);
router.get("/receivables", staff, bookingController.receivables);

// Pagos y conciliación
router.get("/payments", staff, financeController.listPayments);
router.patch("/payments/:id/review", staff, financeController.reviewPayment);

// Gastos y reportes
router.get("/expenses", staff, financeController.listExpenses);
router.post("/expenses", staff, financeController.createExpense);
router.patch("/expenses/:id", staff, financeController.updateExpense);
router.delete("/expenses/:id", staff, financeController.deleteExpense);
router.get("/reports/income-statement", admin, financeController.incomeStatement);
router.get("/reports/production", staff, financeController.production);
router.get("/reports/cash", staff, financeController.cash);

// Catálogo, sucursales y configuración
router.get("/services", admin, catalogController.listServices);
router.post("/services", admin, catalogController.createService);
router.get("/services/:id", admin, catalogController.getService);
router.patch("/services/:id", admin, catalogController.updateService);
router.delete("/services/:id", admin, catalogController.deleteService);
router.get("/branches", staff, catalogController.listBranches);
router.post("/branches", admin, catalogController.createBranch);
router.get("/branches/:id", admin, catalogController.getBranch);
router.patch("/branches/:id", admin, catalogController.updateBranch);
router.get("/settings", admin, catalogController.getSettings);
router.patch("/settings", admin, catalogController.updateSettings);

// Clientes y personal
router.get("/customers", staff, peopleController.listCustomers);
router.post("/customers", staff, peopleController.createCustomer);
router.get("/customers/:id", staff, peopleController.getCustomer);
router.patch("/customers/:id", staff, peopleController.updateCustomer);
// El manager puede listar (solo lavadores de sus sucursales, lo filtra el service).
router.get("/users", staff, peopleController.listUsers);
router.post("/users", admin, peopleController.createUser);
router.get("/users/:id", admin, peopleController.getUser);
router.patch("/users/:id", admin, peopleController.updateUser);

// Cotizaciones de oficina
router.get("/office-quotes", staff, officeQuoteController.list);
router.get("/office-quotes/:id", staff, officeQuoteController.detail);
router.patch("/office-quotes/:id", staff, officeQuoteController.update);
router.post("/office-quotes/:id/convert", staff, officeQuoteController.convert);

router.post("/uploads", any, uploadMiddleware.single("file"), catalogController.upload);

// Operación (fase 2): producción, novedades, turnos, metas y comisiones.
router.use(operationRoutes);

// Finanzas y gestión comercial (fase 2: reportes del Excel de gerencia)
router.use("/finance", financeRoutes);
router.use("/commercial", commercialRoutes);

export default router;
