# Checkout & Rewards Service

Backend for an ecommerce store: carts, checkout, orders, and milestone-based discount coupons
(every n-th placed order makes one x% coupon available; an admin generates it).

The interesting part is behaviour under retries and concurrency. Read these:

- [docs/API.md](docs/API.md): every endpoint, request, response, status and error code
- [docs/FLOWS.md](docs/FLOWS.md): diagrams of each flow (checkout transaction, locks, idempotency, coupons)
- [DECISIONS.md](DECISIONS.md): invariants, design decisions and trade-offs
- [requests.http](requests.http): a runnable walkthrough (VS Code REST Client)

**Stack:** Node.js 20+, TypeScript (strict), Fastify, zod, PostgreSQL 16 via `pg` with hand-written SQL (no ORM), Vitest.

## Prerequisites

- Node.js 20 or newer
- Docker with the compose plugin (Docker Desktop on Windows/macOS)

## Setup and run

```sh
npm install
cp .env.example .env        # the defaults work as-is
npm run db:up               # Postgres 16 on localhost:5433; creates `checkout` and `checkout_test`
npm run db:reset            # drop schema, migrate, seed the dev DB
npm run dev                 # http://localhost:3000 (reloads on change)
curl localhost:3000/health  # {"status":"ok"}
```

Then click through [requests.http](requests.http) top to bottom (it expects a freshly reset DB),
or run the race demo while the server is up:

```sh
npm run demo:race           # 20 parallel checkouts for 3 units of sku_print
```

Expected output: `3 x 201 order placed`, `17 x 409 INSUFFICIENT_INVENTORY`, stock 0. Run `npm run db:reset` before repeating it.

## Tests

```sh
npm run typecheck
npm test                    # all tests, against TEST_DATABASE_URL
npm test -- concurrency     # only the concurrency tests
```

Tests run against a real Postgres (`checkout_test`). The schema is rebuilt from migrations once per run, and
data is truncated and reseeded before each test. Files run serially because they share the database.
The `test/concurrency.*.test.ts` files fire real parallel requests and assert the final DB state
(stock, order count, coupon status), not just status codes.

## Seed data

| id | name | price | stock |
|---|---|---|---|
| `sku_tee` | Classic Tee | 2500 ($25.00) | 100 |
| `sku_mug` | Ceramic Mug | 1299 ($12.99) | 50 |
| `sku_hoodie` | Zip Hoodie | 5999 ($59.99) | 25 |
| `sku_cap` | Logo Cap | 1999 ($19.99) | 40 |
| `sku_sticker` | Sticker Pack | 199 ($1.99) | 1000 |
| `sku_print` | Limited Edition Print | 4999 ($49.99) | **3** (limited) |

The odd prices are deliberate: they exercise floor rounding on percent discounts.

## Configuration

Set in `.env` (see [.env.example](.env.example)). The service validates config at startup and refuses to boot on invalid values.

| Variable | Meaning | Default |
|---|---|---|
| `DATABASE_URL` | Dev database | `postgres://postgres:postgres@localhost:5433/checkout` |
| `TEST_DATABASE_URL` | Test database | `postgres://postgres:postgres@localhost:5433/checkout_test` |
| `PORT` | HTTP port | `3000` |
| `COUPON_EVERY_N_ORDERS` | n: every n-th placed order earns a coupon (integer ≥ 1) | `5` |
| `COUPON_PERCENT` | x: coupon discount percent (integer 1..100) | `10` |

## Commands

| Command | What it does |
|---|---|
| `npm run db:up` / `db:down` | Start / stop Postgres |
| `npm run db:migrate` | Apply `db/migrations/*.sql` to `DATABASE_URL` |
| `npm run db:seed` | Seed products into `DATABASE_URL` |
| `npm run db:reset` | Drop schema, migrate, seed (destroys dev data) |
| `npm run dev` | Run the server with reload |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` / `test:watch` | Run tests once / in watch mode |
| `npm run demo:race` | Oversell demo against the running dev server |

## Layout

```
src/
  app.ts            buildApp(configOverrides?): routes + error handler, no listen
  server.ts         listens on PORT
  config.ts         zod-validated config
  db.ts             pg Pool, int8 parser, withTransaction()
  errors.ts         AppError + error code catalog
  money.ts          integer-cents helpers (pure)
  routes/           thin: validate with zod, call a service, map the result
  services/         cartService, checkoutService, couponService, reportService
db/migrations/      001_init.sql (schema + constraints)
db/seed.sql         products
scripts/            migrate, seed, reset, demo-concurrency
test/               *.test.ts, concurrency.*.test.ts, helpers.ts
```
