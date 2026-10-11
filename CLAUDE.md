# CLAUDE.md

Guía para Claude Code (claude.ai/code) al trabajar en este repositorio.

## Contexto

API de **Nemo Cleaning Services** (limpieza de autos, colchones, muebles, alfombras, hogar y oficinas en Guayaquil;
sucursales Samborondón y Vía a la Costa). La fuente de verdad compartida con el front es
`../CONTRATO-API.md`: si cambias un endpoint o una forma de respuesta, actualiza ese archivo.

## Commands

- **Dev server:** `pnpm dev` (ts-node-dev, puerto 8100)
- **Build:** `pnpm build` (tsc → `dist/`) — es la única verificación; no hay linter ni tests.
- **Start prod:** `pnpm start`
- **Seed:** `pnpm seed` (sucursales, catálogo real si está vacío, settings y admin; idempotente)
- **Migrar catálogo:** `pnpm seed:catalog-real` (upsert por slug del catálogo real de `src/data/realCatalog.ts`, retira el
  de ejemplo y escribe `officePricing`; idempotente, no toca usuarios)
- **Format:** `pnpm format`

## Tech Stack

- Express 5 + TypeScript (CommonJS, ES2024) + Mongoose 8 (`DB_URI`)
- JWT Bearer (30 días). Sin contraseñas: acceso con código de 6 dígitos por correo (`loginCode.service.ts`)
- Payphone Cajita de Pagos (igual que Ponce Rent a Car), Cloudinary (multer en memoria, carpeta `nemo-cleaning/`), Resend
- Vercel: `api/index.ts` es la función; `vercel.json` reescribe todo a `/api`. En el arranque en frío corre `seedBaseData()`.

## Architecture

`Express → CORS → JSON → /api router → routes → controllers → services → models → globalErrorHandler`

- **Routes** (`src/routes/`): endpoints y gates de rol (`requireRoles`). `/admin` y `/operator` pasan por `authMiddleware` y `/customer` por `customerAuthMiddleware` en `routes/index.ts`.
- **Controllers**: parsean req, llaman al service y responden. Sin lógica.
- **Services**: reglas de negocio. Lanzan `CustomError("mensaje en español", status)`.
- **Models**: schemas Mongoose. `counter.model.ts` genera `NEMO-000001` y `COT-000001`.

### Reglas clave

- **Dinero en centavos enteros.** Los precios se recalculan siempre en el servidor (`pricing.service.ts#priceLine`:
  variantes, rangos `priceMax` (se cobra el menor), tramos por cantidad (`utils/tiers.ts`) y m² con decimales). El front
  replica la misma regla en `utils/pricing.ts`: si cambias una, cambia la otra.
- **Catálogo real:** sale de `../recursos/MARCA.md` → `src/data/realCatalog.ts`. No inventar servicios ni precios.
  Cotizador de oficinas = m² × plan (Básico/Profundo) + sillas + ventanales/sanitarios por tramos; plan mensual sin precio.
- **Fechas:** `date` = `"YYYY-MM-DD"`, `time` = `"HH:mm"` en hora de Guayaquil (UTC-5 fijo, ver `utils/date.ts`); `startAt` guarda el instante.
- **Disponibilidad** (`availability.service.ts`): turnos de `openingTime` a `closingTime` cada `slotMinutes` en `workDays`. Un turno se cierra si ya pasó / cae dentro de `bookingLeadHours`, o si los pedidos activos que se cruzan con él (según su `durationMinutes`) ≥ lavadores activos de la sucursal (mínimo 1). El panel puede agendar sin esa validación.
- **Pagos:** `payment.service.ts#recalculatePayments` es el único que calcula `amountPaid`, `balance` y `paymentStatus` desde los `Payment`. Ingreso = pagos `approved` por `paidAt`. Un pago aprobado confirma un pedido `pending`.
- **Payphone:** `payphone.service.ts`. Cada intento es un `Payment` `pending` con `clientTransactionId` ≤ 50; la confirmación es idempotente y con reclamo atómico.
- **Roles:** `admin` todo; `manager` limitado a sus `branches` (`utils/scope.ts`: pedir una sucursal ajena es 403) y solo caja menor; `operator` solo `/operator/*` sobre servicios asignados.
- **Correos:** `bookingEmail.service.ts` con la plantilla de marca de `email.service.ts#layout` (logo PNG servido por el front). Nunca lanzan; un correo caído no rompe la petición. Excepción: el código de
  acceso (`loginCode.service.ts`) responde 502 si no sale, porque sin él no se puede entrar.
- **Acceso:** `/auth/request-code` + `/auth/verify` (personal, solo cuentas activas) y `/customer-auth/*` (clientes; el primer
  verify crea el Customer). `LoginCode` guarda solo el HMAC del código (pepper `JWT_SECRET`), TTL 10 min, 5 intentos,
  60 s entre envíos, un solo uso. Tokens separados: `authMiddleware` rechaza los de cliente (`aud`/`type: "customer"`) y
  `customerAuthMiddleware` solo acepta `aud: "customer"`. `POST /public/bookings` usa `optionalCustomerAuth`.
- **Sueldos, comisiones y metas los escribe gerencia** (ver "Sueldos, comisiones y metas a mano" en el contrato):
  `commissionTotalsByMonth` suma `CommissionEntry` (manual); el FEE de `commission.service.ts` es solo referencia y no
  entra a ningún reporte. Nómina por mes = `PayrollEntry` (`payroll.service.ts#payrollYear/saveSalary`); `monthlySalary`
  del Personal solo propone meses nuevos.
- **Pedidos por WhatsApp** (`whatsapp.service.ts`, `/admin/whatsapp/*`): `source: "whatsapp"` + `paymentMethod: "whatsapp"`
  (= pago por coordinar; los `Payment` siguen siendo card/cash/transfer). La bandeja, la búsqueda por código y el pedido
  rápido reutilizan `createBooking`, `updateAdminBooking`, `changeStatus` y `addManualPayment`: no dupliques reglas allí.
  Payphone aprobado y pagado deja la confirmación en `confirmed` y la cuenta "Tarjeta (Payphone)".
- **Token público:** `Booking.accessToken` tiene `select: false`; solo sale al crear el pedido, en la confirmación de Payphone y como `trackingUrl` en el detalle del panel.

## Convenciones

- Solo `src/config/env.ts` lee `process.env`.
- Comillas dobles, punto y coma, 2 espacios (Prettier).
- Exports nombrados; los routers usan `export default router`. Controllers se importan como namespace.
- Archivos camelCase con sufijo: `booking.service.ts`, `booking.model.ts`, `public.routes.ts`.
- Identificadores genéricos en inglés; dominio, comentarios, mensajes y commits en español. Los comentarios explican el porqué.
- Respuestas sin envoltorio; paginación `{ items, total, page, pages }`; errores `{ message }`.
