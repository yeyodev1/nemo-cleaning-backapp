# nemo-cleaning-backapp

API de Nemo Cleaning Services: pedidos web y del panel, agenda por sucursal, pagos con tarjeta
(Payphone), efectivo y transferencia, conciliación, gastos, reportes y cotizador de oficinas.

Contrato con el front: [`../CONTRATO-API.md`](../CONTRATO-API.md).

## Requisitos

- Node 20+ y pnpm
- MongoDB (Atlas)

## Puesta en marcha

```bash
pnpm install
cp .env.example .env   # completa los valores
pnpm seed              # sucursales, catálogo, settings y cuenta admin (idempotente)
pnpm dev               # http://localhost:8100/api/health
```

La cuenta de gerencia sale de `ADMIN_EMAIL` (y `ADMIN_NAME`). Se crea sola en el primer arranque si no existe.
No hay contraseñas: personal y clientes ingresan con un código de 6 dígitos que llega a su correo (Resend), así que
`RESEND_API_KEY` es necesaria para poder entrar. `ADMIN_PASSWORD` ya no se usa (se ignora si sigue definida).

## Variables de entorno

Ver `.env.example`. Obligatorias: `DB_URI`, `JWT_SECRET`. Sin `PAYPHONE_TOKEN`/`PAYPHONE_STORE_ID` el pago
con tarjeta responde 503; sin `RESEND_API_KEY` no se envían correos (ni los códigos de acceso: el login responde 502); sin Cloudinary las subidas responden 503.

## Despliegue

Vercel con `api/index.ts` como función y todo reescrito a `/api` (`vercel.json`). Configura las mismas
variables en el proyecto. La URL de respuesta de Payphone debe apuntar a `https://nemocleaning.ec/pay-response`.

## Scripts

| Script | Qué hace |
|---|---|
| `pnpm dev` | servidor con recarga |
| `pnpm build` | compila a `dist/` (única verificación) |
| `pnpm start` | corre `dist/index.js` |
| `pnpm seed` | datos base idempotentes |
| `pnpm format` | Prettier |
