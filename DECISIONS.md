# DECISIONS.md

> DRAFT. Factual sections are generated from the code. Every **Why** must be rewritten in my own words before submission. Remaining `TODO(me)` markers are mine to write.

Contents
1. [System invariants](#1-system-invariants)
2. [Ambiguities and the semantics I chose](#2-ambiguities-and-the-semantics-i-chose)
3. [Design decisions](#3-design-decisions)
4. [Transaction, concurrency and idempotency strategy](#4-transaction-concurrency-and-idempotency-strategy)
5. [Money and rounding](#5-money-and-rounding)
6. [Error model](#6-error-model)
7. [Implemented vs deferred](#7-implemented-vs-deferred)
8. [Multiple instances and production scale](#8-multiple-instances-and-production-scale)
9. [How I used AI tools](#9-how-i-used-ai-tools)
10. [What I would examine first with two more hours](#10-what-i-would-examine-first-with-two-more-hours)
11. [Time spent](#11-time-spent)

Diagrams of every flow: [docs/FLOWS.md](docs/FLOWS.md). API: [docs/API.md](docs/API.md).

---

## 1. System invariants

Each invariant is enforced twice: once by application logic (so the client gets a clean, specific error) and once by a database constraint (so a bug in that logic fails loudly instead of corrupting data).

| # | Invariant | Enforced in code | DB constraint | Proven by |
|---|---|---|---|---|
| I1 | `stock >= 0` always; initial stock = current stock + quantity sold | `checkoutService.checkout` step 3–4: products `SELECT ... FOR UPDATE ORDER BY id`, then a per-line stock check before the decrement | `products_stock_nonnegative` | `concurrency.checkout.test.ts`: "20 carts race for 3 units", "10 carts each wanting 2 of 3"; `schema.test.ts` |
| I2 | A cart produces at most one order | `checkout` step 1: cart `SELECT ... FOR UPDATE`, status check | `orders_cart_id_unique` | "retry storm"; `schema.test.ts` |
| I3 | A retried checkout (same payload) returns the original order; no second order, no second decrement | `checkout` step 1 → `replayExistingOrder` (fingerprint compare), before any stock check | `orders_cart_id_unique` | "retry storm"; `checkout.test.ts` "sequential replay ... decrements stock once" |
| I4 | A coupon is REDEEMED iff attached to a committed order; failed checkouts never consume one | `claimCoupon`: single conditional `UPDATE ... WHERE status='AVAILABLE'` inside the checkout transaction | `orders_coupon_id_unique`, `coupons_redeemed_at_matches_status`, `orders_coupon_snapshot_complete` | `concurrency.coupons-redeem.test.ts`; `coupons.redeem.test.ts` "fails on stock / PRICE_CHANGED does not consume the coupon" |
| I5 | At most one coupon per milestone; coupons ≤ floor(orders / n) | `couponService.generateCoupon`: `pg_advisory_xact_lock` serializes calls, then an eligibility check | `coupons_milestone_unique` | `concurrency.coupons-generate.test.ts`; `coupons.generate.test.ts` |
| I6 | `line_total = unit_price × qty`, `subtotal = Σ lines`, `0 ≤ discount ≤ subtotal`, `total = subtotal − discount ≥ 0` | `money.ts` (`lineTotal`, `sumCents`, `percentDiscount`) | `order_lines_line_total_matches`, `orders_total_is_subtotal_minus_discount`, `orders_discount_within_subtotal`, `orders_*_nonnegative` | `money.test.ts` (incl. 5,000 generated subtotals); `schema.test.ts`; "100% coupon → total 0" |
| I7 | Placed orders are immutable snapshots, never read live product data | `checkoutService.loadOrder` reads only `orders` + `order_lines`; no code path updates an order | n/a (no UPDATE path exists) | `checkout.test.ts` "keeps its snapshot after the product price and name change"; report test renames a product |
| I8 | Every report figure is recomputable from orders and coupons; reading never writes | `reportService.getReport`: one `REPEATABLE READ, READ ONLY` transaction, no stored aggregates | read-only transaction | `report.test.ts` "reconciles with ... the API returned", "is read-only" |

### Evidence: mutation checks

Each lock or conditional was removed on purpose, to confirm a test fails without it. Run during development; to re-run one by hand, edit the line and run `npm test -- concurrency`.

| Mutation | Test that failed | How it failed |
|---|---|---|
| Removed `FOR UPDATE` on the products SELECT | both oversell tests | decrements hit `CHECK (stock >= 0)`: 500s instead of 409s |
| Removed `FOR UPDATE` on the cart SELECT | retry storm; edit-vs-checkout | retry: second tx hits `orders_cart_id_unique` (500). Edit race: order qty 1 while the cart says 2 |
| Products locked in cart-add order instead of by id | 30-cart opposite-order test | deadlocks (40P01) surface as 500s |
| Coupon claim as `SELECT` then unconditional `UPDATE` | coupon redeem race, all 5 rounds | `[201, 500]` instead of `[201, 409]`: only the `UNIQUE(coupon_id)` backstop saved the data |
| Coupon generation retry disabled | coupon generation race | *the first version of the test still passed*: a plain `Promise.all` never made the short transactions collide. Fixed the test with `raceBehindTableLock`; now both tests fail without the retry |
| (after review) Advisory lock removed from generation | all 3 generation race tests | `[201, 500, ...]`: concurrent calls compute the same milestone and the backstop refuses them |
| (after review) `ORDER BY id` deleted from the products lock | **none: survives** | on a 6-row table every seq scan locks in the same physical order, so the sort can't be told apart from no sort. The sort is a guarantee that doesn't depend on the plan; the test catches the realistic bug (locking in cart order) |
| (after review) `expectedTotalCents` added to the fingerprint | `checkout.test.ts` replay with a different expectedTotalCents | 409 instead of a 200 replay |
| Dropped `CHECK (stock >= 0)` | none in the concurrency suite (expected) | locks alone prevent oversell; the constraint is a backstop |

---

## 2. Ambiguities and the semantics I chose

| Question the brief leaves open | Choice |
|---|---|
| Price changes between add-to-cart and checkout | Carts store only product + quantity. The cart view shows **live** prices. Checkout charges the **current** price and snapshots it. The client can send `expectedTotalCents`; a mismatch is 409 `PRICE_CHANGED` with the new figures. |
| Stock drops after an item was added | No reservation. Adding checks stock (advisory 409). The cart view shows a `warnings[]` entry per line that now exceeds stock. Checkout is authoritative and all-or-nothing. |
| Partial fulfilment? | No. Any shortfall fails the whole checkout and lists **every** short line. |
| What counts as "the same" checkout retry? | Same cart id (the idempotency key) **and** same normalized coupon code (the fingerprint). `expectedTotalCents` is a guard, not part of the intent. |
| Retry with a different payload | 409 `CART_ALREADY_CHECKED_OUT` with `existingOrderId`. |
| Are failed checkouts cached for replay? | No. The cart stays OPEN and a retry re-evaluates. |
| When is milestone k reached? | When placed orders ≥ k × n. |
| How many coupons per generate call? | One: the lowest unrewarded reached milestone. Call again for the next. |
| Do orders that used a coupon count toward milestones? | Yes. Every placed order counts. |
| Coupon binding / expiry | Bearer code, not bound to a customer, no expiry, case-insensitive, whitespace-tolerant. |
| Coupons per order | At most one. |
| Coupon percent if config changes later | Snapshotted onto the coupon at generation; the order snapshots it again. |
| Rounding the discount | `floor(subtotal × percent / 100)`: in the customer's favour, then clamped to `[0, subtotal]`. |
| Quantity limits | Integer 1..100 per line. Quantity 0 is a validation error; removing uses `DELETE`. |
| Payment | No fake gateway: a committed checkout counts as paid (Decision 5). |
| Report: product name if renamed | The name from the most recent order snapshot, never live product data. |
| Malformed ids | 404 (an id that cannot exist is "not found"), never a 500 from a UUID cast. |

---

## 3. Design decisions

### Decision 1: Pessimistic row locks in Postgres for checkout

**Context:** Concurrent checkouts compete for the same stock, the same cart (retries) and the same coupon. Any check-then-write race oversells, double-orders or double-redeems.

**Options considered:**
- Pessimistic row locks (`SELECT ... FOR UPDATE`) in one transaction, fixed lock order.
- Optimistic concurrency: a `version` column, `UPDATE ... WHERE version = $v`, retry on conflict.
- Atomic conditional decrements only: `UPDATE products SET stock = stock - q WHERE stock >= q` per line, no SELECT lock.
- `SERIALIZABLE` isolation with retry on 40001.
- An in-process mutex or queue per product.

**Choice:** Pessimistic locks, `READ COMMITTED`, lock order cart → products (id ascending) → coupon. Coupon claim by conditional UPDATE. DB constraints as a backstop.

**Why:** *(rewrite in my own words)* Contention is on a few hot rows and the transaction is short, so waiting is cheaper than abort-and-retry. Locking the rows up front lets me report **all** shortfalls with exact `available` numbers in one response; per-line conditional decrements fail on the first short line. Optimistic and SERIALIZABLE both push retry loops into the request path and turn contention into wasted work. An in-process mutex breaks the moment there are two instances. The fixed lock order removes deadlocks. The test with opposite-ordered carts catches the realistic bug (locking in cart order); see the mutation table for what it can't distinguish.

**Consequences:** Checkouts of the same product serialize: throughput on one very hot SKU is bounded by transaction latency (see §8). No retry logic is needed in checkout. The rules are easy to verify by reading the SQL, which is why there is no ORM.

### Decision 2: The cart id is the idempotency key

**Context:** Clients retry checkout after timeouts. A retry must not create a second order or decrement stock twice, and must return the original result.

**Options considered:**
- Cart id as the key, with the order row itself as the stored result (`UNIQUE(orders.cart_id)`).
- A general `Idempotency-Key` header with a table storing the request hash and response, with a TTL.

**Choice:** Cart id. The fingerprint (normalized coupon code) is stored on the order. Same fingerprint gives a 200 replay with `Idempotent-Replayed: true`; a different fingerprint gives 409.

**Why:** *(rewrite)* A cart can be checked out at most once by definition, so it is already a natural idempotency key. No extra table, no TTL, no response cache to keep consistent, and the replay is built from the order itself, so it can't drift from the truth. The cart row lock serializes concurrent retries.

**Consequences:** Works only for checkout. Other non-idempotent POSTs (`POST /carts`, `POST /admin/coupons`) are not deduplicated: a retried `POST /carts` creates an empty extra cart (harmless), and a retried generate may create the *next* milestone's coupon if one is also eligible. A general Idempotency-Key store is deferred (§7).

### Decision 3: No stock reservation; checkout is authoritative

**Context:** Stock can change between add-to-cart and checkout.

**Options considered:**
- No reservation: an advisory check at add time, an authoritative check at checkout.
- Reserve stock on add, with a TTL and a sweeper to release abandoned carts.

**Choice:** No reservation. A PUT above current stock gets 409. The cart view shows warnings; checkout re-checks under lock.

**Why:** *(rewrite)* Reservations need expiry, a background job, and a rule for every cart edit, and abandoned carts would lock stock away from real buyers. In the timebox, the correctness risk worth spending on is "never oversell at checkout", which locks solve completely. The customer is told early (warnings) and precisely (409 with every shortfall).

**Consequences:** A customer can lose an item to someone else between adding and paying. Fine for a store like this; not for ticketing.

### Decision 4: Live pricing, plus an optional `expectedTotalCents` guard

**Context:** Prices can change after an item is in a cart. The brief asks me to decide and document.

**Options considered:**
- Freeze the price at add time (store it on `cart_items`).
- Always charge the current price, with no guard.
- Charge the current price, and let the client pin the total it showed.

**Choice:** Current price at checkout, snapshotted into the order. Optional `expectedTotalCents`; a mismatch is 409 `PRICE_CHANGED` with the actual figures.

**Why:** *(rewrite)* Freezing at add time lets a cart hold a stale (possibly erroneous) price forever and needs rules about expiry. Silently charging a different price than the customer saw is worse. The guard gives the client a way to say "only charge what I showed", without the server storing quotes.

**Consequences:** Clients that don't send `expectedTotalCents` accept the current price. The check compares against the total **after** the discount, so a client must include the coupon in its expectation.

### Decision 5: No payment fake; payment never runs inside the DB transaction

**Context:** No real payment integration is required.

**Options considered:**
- No fake: a committed checkout counts as paid.
- A fake gateway called during checkout.

**Choice:** No fake.

**Why:** *(rewrite)* A fake would make the code look complete while teaching the wrong thing: a real gateway call must never run inside a transaction holding row locks, because a slow or hung gateway would block every other checkout of the same products, and a timeout would leave us not knowing whether the charge happened. Done properly it needs a saga (order `PENDING` → charge → `PLACED`/`FAILED`, with an outbox and compensation), which is out of scope. A fake would hide that.

**Consequences:** The design is honest about what is deferred (§7, §8). Adding payment means changing the order state machine, not just inserting a call.

### Decision 6: PUT with absolute quantity instead of POST increment

**Context:** Cart edits are retried too.

**Options considered:** `PUT /carts/:id/items/:productId {quantity}` (set) vs `POST /carts/:id/items {productId, delta}` (increment).

**Choice:** PUT, absolute quantity. DELETE to remove (idempotent, 200 even when the line is already absent).

**Why:** *(rewrite)* Setting is naturally idempotent; incrementing double-adds on retry and would need its own idempotency key.

**Consequences:** A client must know the quantity it wants rather than "one more". Two tabs editing the same cart: last write wins (each edit is still atomic and locked).

### Decision 7: An on-demand `REPEATABLE READ` report instead of maintained aggregates

**Context:** The report must reconcile with orders and coupons, and reading it must not mutate state.

**Options considered:**
- Compute on demand from `orders`, `order_lines` and `coupons`.
- Maintain counters/aggregates updated inside checkout.
- A materialized view refreshed periodically.

**Choice:** On demand, three queries in one `REPEATABLE READ, READ ONLY` transaction, all aggregates `::bigint`.

**Why:** *(rewrite)* Stored aggregates are a second source of truth that can drift, and every checkout would contend on the counter row. On demand is always consistent by construction. `REPEATABLE READ` makes the three queries share one snapshot, so an order committing mid-report can't make product quantities disagree with revenue. `READ ONLY` makes "never writes" a database guarantee, not a convention.

**Consequences:** Cost grows with order count (full scans). Fine at this scale; see §8 for production.

### Decision 8: One coupon per generate call, with uniqueness from the constraint

**Context:** "Generate a coupon when an unrewarded milestone is eligible." Several milestones may be pending, and admins may click twice.

**Options considered:**
- One coupon per call (the lowest pending milestone).
- Generate all pending milestones in one call.
- Generate automatically inside checkout when an order crosses a milestone.

**Choice:** One per call. Calls are serialized with a transaction-scoped Postgres advisory lock, so each sees the previous call's coupon; `UNIQUE(milestone)` is the backstop.

**Why:** *(rewrite)* Matches the brief's wording ("an administrator can request coupon generation"). One call, one resource keeps the 201 response simple. Generating inside checkout would add a write and contention to the hot path, and couple a customer's request to an admin concern. The first version used "insert, retry on unique violation (3 attempts)"; review showed that 12 simultaneous calls for 12 pending milestones gave 3 × 201 and 9 × 500, because losers kept losing. Serializing removes the race rather than retrying it, and for a rare admin action the queuing costs nothing. The advisory lock lives in Postgres, so it still works with several app instances.

**Consequences:** Catching up on k pending milestones takes k calls (or k simultaneous calls, which now each get one). Generation runs one at a time, which is irrelevant for an admin action. A code collision (`SAVE-` plus 8 of 32 symbols, about 10^12 codes) would surface as a 500; it is not retried.

### Decision 9: Postgres with hand-written SQL, no ORM

**Context:** Correctness depends on exactly which rows are locked, in which order, and on conditional updates.

**Options considered:** an ORM / query builder vs `pg` with SQL in the services; in-memory store vs a real DB.

**Choice:** Postgres 16 and `pg`, SQL inline in the services, tests against a real database.

**Why:** *(rewrite)* Every `FOR UPDATE`, lock order and `WHERE status = 'AVAILABLE'` is visible on the page and can be reviewed line by line. An in-memory store would need me to re-implement locking and would say nothing about multiple instances. Testing against real Postgres means the concurrency tests exercise real row locks.

**Consequences:** More SQL to read. Integer cents need the custom `int8` parser that refuses unsafe integers.

---

## 4. Transaction, concurrency and idempotency strategy

**Principle:** the app is stateless; Postgres is the only coordinator. No in-process locks, maps or caches are used for correctness.

**Checkout: one transaction** (`checkoutService.checkout`):

1. `SELECT status FROM carts WHERE id=$1 FOR UPDATE`. If `CHECKED_OUT`: same fingerprint → replay the stored order (200); different → 409. *This comes before any stock check.*
2. Load `cart_items`. None → 422 `CART_EMPTY`.
3. `SELECT ... FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE`.
4. Check every line; collect all shortfalls → 409. Compute lines and subtotal with `money.ts`.
5. If a coupon is given: `UPDATE coupons SET status='REDEEMED', redeemed_at=now() WHERE code=$1 AND status='AVAILABLE' RETURNING ...`. No row → `SELECT` to tell 422 (unknown) from 409 (already redeemed).
6. `expectedTotalCents` mismatch → 409 `PRICE_CHANGED`.
7. `INSERT orders` + `order_lines` (snapshot); `UPDATE products SET stock = stock - qty`; `UPDATE carts SET status='CHECKED_OUT'`.
8. `COMMIT`. Any throw → `ROLLBACK`, which also releases the coupon claim.

**Lock order:** cart → products by id → coupon. Every multi-lock path follows it, so no cycle (deadlock) can form.

**Why READ COMMITTED is enough:** after waiting on a row lock, `FOR UPDATE` and `UPDATE` re-check the **latest committed** row version. So a checkout that waited on `sku_print` sees the decremented stock, and a coupon claim that waited sees `REDEEMED`.

**Cart edits** take the same cart row lock and check `status = 'OPEN'` in the same transaction, so an edit is either fully before a checkout (the order includes it) or fully after (409).

**Coupon generation:** `SELECT pg_advisory_xact_lock(...)` first, so generate calls run one at a time across all instances; then read the order count and `MAX(milestone)`, and insert milestone + 1. `UNIQUE(milestone)` is the backstop. A stale order count can only under-generate, never over-generate (orders are never deleted).

**Report:** `REPEATABLE READ, READ ONLY`, one snapshot.

**Testing it:** the concurrency tests set up first, then fire all requests at once with `Promise.all` (handlers run concurrently, each on its own pooled connection; pool size 20). For the coupon races, where the transactions are too short to overlap reliably, `raceBehindTableLock` holds a `SHARE ROW EXCLUSIVE` lock until every request has done its reads and is blocked on its write, then releases them together. Tests assert final DB state and that every response is an expected outcome (no 500s).

---

## 5. Money and rounding

- All money is **integer cents** in `BIGINT` columns. The `pg` int8 parser converts to `number` and **throws** if a value is not a safe integer (> 2^53 − 1), rather than silently losing precision.
- Aggregates are cast `SUM(...)::bigint` (Postgres returns `numeric` for `SUM(bigint)`, which would arrive as a string).
- `money.ts` functions reject anything that is not a non-negative safe integer: no floats, no `parseFloat`, no `toFixed`.
- `line_total = unit_price × quantity`; `subtotal = Σ line_total`.
- `discount = floor(subtotal × percent / 100)`, computed with exact integer arithmetic (`(p − p % 100) / 100`), then clamped to `[0, subtotal]`. Rounding down favours the customer and is deterministic.
- `total = subtotal − discount ≥ 0`. A 100% coupon gives total 0, never negative.
- The discount is per order, not distributed across lines. `productsSold.grossCents` in the report is therefore before discounts.

| subtotal | % | exact | discount | total |
|---|---|---|---|---|
| 1299 | 10 | 129.9 | 129 | 1170 |
| 199 | 10 | 19.9 | 19 | 180 |
| 5 | 10 | 0.5 | 0 | 5 |
| 999 | 33 | 329.67 | 329 | 670 |
| 1498 (mug + sticker) | 10 | 149.8 | 149 | 1349 |
| 1000 | 100 | 1000 | 1000 | 0 |

---

## 6. Error model

One shape everywhere: `{ "error": { "code", "message", "details?" } }`. Clients branch on `code`; `details` carries machine-readable context (all shortfalls, the actual total, the existing order id, milestone progress).

| Code | HTTP |
|---|---|
| `VALIDATION_ERROR` | 400 |
| `NOT_FOUND` (unknown route) | 404 |
| `CART_NOT_FOUND`, `ORDER_NOT_FOUND` | 404 |
| `PRODUCT_NOT_FOUND`, `CART_EMPTY`, `COUPON_NOT_FOUND` | 422 |
| `CART_ALREADY_CHECKED_OUT`, `INSUFFICIENT_INVENTORY`, `PRICE_CHANGED`, `COUPON_ALREADY_REDEEMED`, `NO_ELIGIBLE_MILESTONE` | 409 |
| `INTERNAL_ERROR` | 500 |

- **409 vs 422:** 409 = a valid request that conflicts with the **current state** of a resource (stock, price, coupon status, cart status): it may succeed later or with different input, and the client can react (refresh the cart, drop the coupon). 422 = the request refers to something that doesn't exist or can't be processed as given (unknown product or coupon, empty cart): retrying unchanged will never work.
- **404 for malformed ids:** an id that cannot be a UUID cannot name a cart; returning 400 would leak an implementation detail, and passing it to Postgres would produce a cast error (500).
- **The code→status mapping lives in one place** (`ERROR_STATUS` in `errors.ts`); every error is created by a factory.
- **Nothing leaks:** unknown errors become a generic 500 and are logged server-side; SQL, stack traces and driver messages never reach the client (tested).
- **Constraint violations are a backstop, not a feature:** in normal operation the app returns a specific 4xx before a constraint fires. If one does fire, that's a bug and correctly surfaces as a 500. The mutation checks show exactly this.

---

## 7. Implemented vs deferred

**Implemented:** products; carts (create, view, set quantity, remove) with live pricing and stock warnings; atomic, idempotent checkout with order snapshots and all-shortfall reporting; `expectedTotalCents` guard; milestone coupon generation safe under concurrency; single-use coupon redemption inside checkout; read-only reconciling report; uniform error model; config validation; 99 tests (3 concurrency files) on a real DB; API docs, REST Client walkthrough, race demo, flow diagrams.

**Deferred, deliberately:**
- Authentication / authorization (admin routes are only marked by the `/admin` prefix).
- Payment and a payment saga (Decision 5).
- Stock reservation with expiry (Decision 3).
- A general `Idempotency-Key` store for non-checkout POSTs (Decision 2).
- Lock and statement timeouts (`lock_timeout`, `statement_timeout`, pool `connectionTimeoutMillis`): today a stuck transaction holding a hot product row would block that product's checkouts indefinitely.
- `FOR NO KEY UPDATE` instead of `FOR UPDATE` on products: enough for a stock update, and it would not conflict with the `FOR KEY SHARE` taken by the `cart_items` foreign-key check.
- `orders.request_fingerprint` should be `NOT NULL` (the code always sets it).
- A concurrent test for the report's snapshot (checkouts committing during repeated reports). Today, dropping `REPEATABLE READ` would not fail a test.
- Product management endpoints (prices and stock change only via SQL/seed).
- Pagination on `GET /admin/coupons`, `GET /products`.
- Rate limiting, request ids / structured audit log, metrics.
- Multi-currency (everything is USD).
- Cart expiry / cleanup of abandoned carts.

`TODO(me)`: confirm this list and add anything I consciously skipped.

---

## 8. Multiple instances and production scale

`TODO(me)`: write this section myself. Points to cover:
- the app is stateless; all locking already lives in Postgres, so N instances behind a load balancer need no change
- hot-product row contention (one SKU serializes its checkouts) and mitigations: reservations, a queue-based checkout per SKU, split/sharded stock counters
- a payment saga: order `PENDING`, an outbox, charge outside the transaction, compensation on failure
- an `Idempotency-Key` store with a TTL for non-cart operations
- read replicas or materialized aggregates for reporting
- event-driven coupon generation (an order-placed event, instead of an admin poll)
- connection pool sizing (instances × pool size ≤ Postgres `max_connections`; use PgBouncer in transaction mode, which is compatible with this design since no session state is used)

---

## 9. How I used AI tools

`TODO(me)`: write from AI_LOG.md, in my own words. Must include at least one concrete correction, rejection or redirect.

---

## 10. What I would examine first with two more hours

`TODO(me)`

---

## 11. Time spent

`TODO(me)`: approximately __ hours. State anything incomplete honestly.
