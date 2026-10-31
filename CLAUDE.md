# CLAUDE.md: Checkout & Rewards Service

Context for Claude Code. Read this fully before every task.

## What we're building

This is the backend for an ecommerce store: carts, checkout, orders, and milestone-based discount coupons. Every nth successfully placed order makes one x% coupon available, and the coupon is created when an admin requests generation.

The assignment is graded on correctness under retries and concurrency, and on the reasoning behind each choice. Feature count does not matter. Prefer small, explicit, verifiable code over clever abstractions.

## Stack

- Node.js 20+, TypeScript (strict mode)
- Fastify for HTTP, zod for request validation
- PostgreSQL 16 via docker compose
- `pg` (node-postgres) with hand-written SQL. **No ORM**: row locks and conditional updates must be explicit and visible in the code.
- Vitest for tests, running against a real Postgres test database

> If the stack changes, update this section first.

## Commands

| Command | What it does |
|---|---|
| `npm run db:up` | Start Postgres (docker compose) |
| `npm run db:down` | Stop Postgres |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL` |
| `npm run db:seed` | Seed products into `DATABASE_URL` |
| `npm run db:reset` | Drop schema, migrate, seed (dev DB) |
| `npm run dev` | Run the server with reload |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run all tests once against `TEST_DATABASE_URL` |
| `npm run test:watch` | Vitest watch mode |

## Configuration (env)

| Variable | Meaning | Default |
|---|---|---|
| `DATABASE_URL` | Dev database | `postgres://postgres:postgres@localhost:5433/checkout` |
| `TEST_DATABASE_URL` | Test database | `postgres://postgres:postgres@localhost:5433/checkout_test` |
| `PORT` | HTTP port | `3000` |
| `COUPON_EVERY_N_ORDERS` | n, integer >= 1 | `5` |
| `COUPON_PERCENT` | x, integer 1..100 | `10` |

Config is validated at startup, and the service refuses to boot on invalid values. `buildApp()` accepts config overrides so tests can use a small n (for example, 3).

## Layout

```
src/
  app.ts            buildApp(configOverrides?) -> Fastify instance (no listen)
  server.ts         listens on PORT
  config.ts         zod-validated config
  db.ts             pg Pool, int8 parser, withTransaction()
  errors.ts         AppError + error code catalog
  money.ts          integer-cents helpers (pure)
  routes/           products.ts, carts.ts, orders.ts, admin.ts  (thin)
  services/         cartService.ts, checkoutService.ts, couponService.ts, reportService.ts
db/
  migrations/       001_init.sql, ...
  seed.sql
scripts/            migrate.ts, seed.ts, reset.ts
test/               helpers.ts, *.test.ts, concurrency.*.test.ts
```

## Invariants (never break these)

- **I1 Inventory:** `products.stock >= 0` always. For each product, initial stock = current stock + quantity sold in placed orders.
- **I2 One order per cart:** a cart produces at most one order (`orders.cart_id UNIQUE`).
- **I3 Idempotent checkout:** a retried checkout of the same cart with the same payload returns the original order. It never creates a second order and never decrements stock twice.
- **I4 Coupon single use:** a coupon is REDEEMED if and only if it is attached to a committed order (`orders.coupon_id UNIQUE`). A failed checkout never consumes a coupon.
- **I5 Milestones:** at most one coupon per milestone (`coupons.milestone UNIQUE`), and coupons generated <= floor(placed orders / n).
- **I6 Totals:** `line_total = unit_price * quantity`, `subtotal = sum(line totals)`, `0 <= discount <= subtotal`, and `total = subtotal - discount >= 0`.
- **I7 Snapshots:** placed orders are immutable and never read live product data.
- **I8 Report:** every report figure can be recomputed from orders and coupons, and reading the report never writes.

## Non-negotiable implementation rules

1. **Money is integer cents.** Store it as `BIGINT`. `db.ts` installs an int8 type parser that converts to `number` and throws if the value is not a safe integer. Cast SQL aggregates with `SUM(...)::bigint`, because Postgres returns `numeric` for `SUM(bigint)`. Never use floats, `parseFloat`, or `toFixed` for money math.
2. **Checkout is exactly one DB transaction.** All reads, checks, the coupon claim, the order insert, the stock decrements, and the cart status change happen inside it. Any error means a full rollback.
3. **Lock order is fixed:** the cart row first (`SELECT ... FOR UPDATE`), then products `FOR UPDATE` sorted by id ascending, then the coupon. This order prevents deadlocks.
4. **Coupon claims use a conditional update:** `UPDATE coupons SET status='REDEEMED' ... WHERE code=$1 AND status='AVAILABLE' RETURNING ...`. Never read the status and then write it in a separate step.
5. **Cart edits lock the cart row** (`FOR UPDATE`) and check `status='OPEN'` inside the same transaction. That way an edit cannot interleave with a checkout.
6. **No in-process locks, mutexes, maps, or caches for correctness.** The design must stay correct with multiple app instances sharing one database.
7. **DB constraints mirror the invariants** (CHECK, UNIQUE, FK). Never remove or weaken a constraint to make code work.
8. **Orders store snapshots:** product name, unit price, quantity, line total, subtotal, discount amount, discount percent, and coupon code.
9. **Routes are thin.** A route validates input with zod, calls a service, and maps the result to a response. Business rules live in services.
10. **All expected failures are thrown as `AppError(code, status, message, details?)`.** Never leak stack traces, SQL, or raw driver errors to clients. Unknown errors become `500 INTERNAL_ERROR` and are logged.
11. **The report runs in a `REPEATABLE READ, READ ONLY` transaction**, so all figures come from one snapshot. No stored aggregates.

## Error model

Every error response has the same shape:

```json
{ "error": { "code": "INSUFFICIENT_INVENTORY", "message": "human readable", "details": { } } }
```

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Malformed JSON, wrong types, missing fields, bad quantity |
| `CART_NOT_FOUND` | 404 | Unknown cart id |
| `ORDER_NOT_FOUND` | 404 | Unknown order id |
| `PRODUCT_NOT_FOUND` | 422 | Unknown product referenced in a cart operation |
| `CART_EMPTY` | 422 | Checkout of a cart with no items |
| `COUPON_NOT_FOUND` | 422 | Unknown coupon code at checkout |
| `CART_ALREADY_CHECKED_OUT` | 409 | Editing a checked-out cart, or retrying checkout with a different payload |
| `INSUFFICIENT_INVENTORY` | 409 | Not enough stock; `details.items = [{productId, requested, available}]` |
| `PRICE_CHANGED` | 409 | `expectedTotalCents` does not match the computed total; details include the current figures |
| `COUPON_ALREADY_REDEEMED` | 409 | Coupon already used |
| `NO_ELIGIBLE_MILESTONE` | 409 | Admin generate with no unrewarded milestone; details include progress |
| `INTERNAL_ERROR` | 500 | Anything unexpected |

## API

Admin operations live under `/admin`. Auth is out of scope, but the prefix marks them as privileged.

| Method & path | Success |
|---|---|
| `GET /health` | 200 |
| `GET /products` | 200 |
| `POST /carts` | 201 |
| `GET /carts/:cartId` | 200 |
| `PUT /carts/:cartId/items/:productId` body `{quantity}` (add or set absolute quantity) | 200, returns the cart |
| `DELETE /carts/:cartId/items/:productId` (idempotent) | 200, returns the cart |
| `POST /carts/:cartId/checkout` body `{couponCode?, expectedTotalCents?}` | 201 new order; 200 replay with header `Idempotent-Replayed: true` |
| `GET /orders/:orderId` | 200 |
| `POST /admin/coupons` | 201 |
| `GET /admin/coupons` | 200 |
| `GET /admin/report` | 200 |

## Domain decisions already made

**Pricing**
- Carts store product references and quantities only. Viewing a cart shows live prices.
- Checkout charges current prices and snapshots them into the order.
- The optional `expectedTotalCents` field protects the client from paying a price it didn't see: a mismatch returns `PRICE_CHANGED`.

**Inventory**
- Adding to a cart does not reserve stock. The add-time stock check is advisory (409 if the quantity exceeds current stock); checkout is authoritative.
- Checkout is all-or-nothing, with no partial fulfillment.
- Quantity per line is an integer from 1 to 100.

**Checkout idempotency**
- The cart id is the idempotency key.
- The request fingerprint is the normalized coupon code (trimmed, uppercased, or `null`).
- Replaying a checkout with the same fingerprint returns the existing order with 200. A different fingerprint returns 409 `CART_ALREADY_CHECKED_OUT`.
- Failed checkouts are not cached; a retry re-evaluates.

**Coupons**
- Milestone k is reached when placed orders >= k * n.
- Each generate call creates one coupon for the lowest unrewarded eligible milestone.
- Coupons are bearer codes: not bound to a customer, no expiry. Codes are case-insensitive.
- One coupon per order. Orders that used a coupon still count toward milestones.
- The coupon percent is snapshotted from config when the coupon is generated.

**Discount**
- `discount = floor(subtotal_cents * percent / 100)`, clamped to `[0, subtotal]`. Rounding is down, so it favors the customer.

**Payment**
- No payment fake. A committed checkout counts as paid.
- A real gateway call must never run inside a DB transaction holding locks; production would use a saga. This is documented as deferred.

## Testing rules

- Tests hit real Postgres (`TEST_DATABASE_URL`). Reset the database (truncate + reseed) before each test.
- Test files run serially (`fileParallelism: false`) because they share one database.
- Concurrent tests must be **truly concurrent**. Do the setup first, then fire all requests together with `Promise.all`. The pool size must be >= 20.
- Concurrency tests assert **final DB state** (stock, order count, coupon status), not just HTTP codes.
- Concurrency tests assert that **every response is an expected outcome**. Any 500 fails the test.
- Concurrency test files are named `test/concurrency.*.test.ts`.
- **Never weaken, skip, or delete a test to make it pass.** If a test looks wrong, stop and explain why.
- A few meaningful tests beat many shallow ones.

## How to work with me

- For non-trivial tasks, propose a short plan first. If the task says "plan first", wait for my approval before editing.
- Keep diffs focused on the current task. Do not refactor unrelated code.
- After changes, run `npm run typecheck` and `npm test` and report the results honestly, including failures.
- Do not edit `DECISIONS.md` or `AI_LOG.md` unless the task asks. Never invent content for the AI-usage section.
- If something is ambiguous and not covered here, ask instead of guessing.
