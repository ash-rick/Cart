# API reference

Base URL: `http://localhost:3000`. All bodies are JSON. All money values are **integer cents** (USD).
Runnable examples for every endpoint are in [`requests.http`](../requests.http).

## Conventions

**Errors.** Every error response has the same shape:

```json
{ "error": { "code": "INSUFFICIENT_INVENTORY", "message": "human readable", "details": { } } }
```

`details` is present only when it carries something useful. Clients should branch on `code`, never on `message`.

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Malformed JSON, wrong types, missing or unknown fields, bad quantity. `details.issues = [{path, message}]` for field errors |
| `NOT_FOUND` | 404 | No such route |
| `CART_NOT_FOUND` | 404 | Unknown cart id (a malformed id is also 404: it cannot name a cart) |
| `ORDER_NOT_FOUND` | 404 | Unknown order id (malformed ids too) |
| `PRODUCT_NOT_FOUND` | 422 | Unknown product in a cart operation |
| `CART_EMPTY` | 422 | Checkout of a cart with no items |
| `COUPON_NOT_FOUND` | 422 | Unknown coupon code at checkout |
| `CART_ALREADY_CHECKED_OUT` | 409 | Editing a checked-out cart, or retrying checkout with a different payload |
| `INSUFFICIENT_INVENTORY` | 409 | Not enough stock. `details.items = [{productId, requested, available}]` lists **every** short line |
| `PRICE_CHANGED` | 409 | `expectedTotalCents` does not match the computed total |
| `COUPON_ALREADY_REDEEMED` | 409 | Coupon already used by another order |
| `NO_ELIGIBLE_MILESTONE` | 409 | Admin coupon generation with no unrewarded milestone reached |
| `INTERNAL_ERROR` | 500 | Anything unexpected. Generic message; the real error is only logged |

**409 vs 422.** 409 means the request is well-formed and refers to real things, but conflicts with the current state (stock, price, coupon status, cart status): it might succeed later or with different input. 422 means the request refers to something that doesn't exist or can't be processed as given.

**Admin.** Operations under `/admin` are administrative. Authentication is out of scope; the prefix marks them as privileged.

---

## `GET /health`

200 `{"status":"ok"}` after a `SELECT 1` against the database. If the DB is down: 500 `INTERNAL_ERROR`.

## `GET /products`

200, ordered by id:

```json
[{ "id": "sku_cap", "name": "Logo Cap", "priceCents": 1999, "stock": 40 }, ...]
```

---

## Carts

### Cart view

Returned by every cart endpoint. Prices and stock are **live**, read from `products` at view time.

```json
{
  "id": "d58b971d-3cf4-4d03-8489-9499f0d762ef",
  "status": "OPEN",
  "currency": "USD",
  "items": [
    { "productId": "sku_print", "name": "Limited Edition Print", "unitPriceCents": 4999,
      "quantity": 3, "lineTotalCents": 14997, "availableStock": 2, "inStock": false }
  ],
  "itemCount": 3,
  "subtotalCents": 14997,
  "warnings": [
    { "code": "INSUFFICIENT_INVENTORY", "productId": "sku_print", "requested": 3, "available": 2 }
  ]
}
```

- `status`: `OPEN` | `CHECKED_OUT`.
- `itemCount`: total units (sum of quantities), not the number of lines.
- `warnings`: lines whose quantity now exceeds stock. This is how the cart surfaces stock changes made after an item was added. Checkout would fail with 409 for these lines.
- Items are ordered by `productId`.

### `POST /carts`

No body. **201** with an empty cart view.

### `GET /carts/:cartId`

**200** cart view. Errors: 404 `CART_NOT_FOUND`.

### `PUT /carts/:cartId/items/:productId`

Sets the **absolute** quantity of a product (insert or update). Sending the same PUT twice leaves the cart unchanged.

Body: `{ "quantity": integer 1..100 }`

**200** updated cart view.

| Error | When |
|---|---|
| 400 `VALIDATION_ERROR` | body missing or malformed; `quantity` missing, not an integer, a string, < 1 or > 100 |
| 404 `CART_NOT_FOUND` | unknown or malformed cart id |
| 422 `PRODUCT_NOT_FOUND` | unknown product |
| 409 `INSUFFICIENT_INVENTORY` | `quantity` > current stock. Advisory only: nothing is reserved |
| 409 `CART_ALREADY_CHECKED_OUT` | cart is `CHECKED_OUT` |

Validation order: body → cart exists → cart is OPEN → product exists → stock.

### `DELETE /carts/:cartId/items/:productId`

Removes a line. **Idempotent**: 200 with the cart view even if the item (or the product) was not in the cart.

| Error | When |
|---|---|
| 404 `CART_NOT_FOUND` | unknown or malformed cart id |
| 409 `CART_ALREADY_CHECKED_OUT` | cart is `CHECKED_OUT` |

---

## Checkout and orders

### `POST /carts/:cartId/checkout`

Body (optional; may be omitted entirely):

```json
{ "couponCode": "SAVE-8JBX9XKS", "expectedTotalCents": 5400 }
```

| Field | Type | Notes |
|---|---|---|
| `couponCode` | string ≤ 64, optional | Trimmed and upper-cased. Empty or whitespace-only means no coupon |
| `expectedTotalCents` | integer ≥ 0, optional | The total the client showed the customer. If the computed total (after discount) differs: 409 `PRICE_CHANGED` |

Unknown fields are rejected (400), so a misspelt `coupon` can't silently check out at full price.

**201** new order. **200** with header `Idempotent-Replayed: true` when the cart was already checked out by a request with the same fingerprint (the normalized coupon code). The body is then the original order.

Order shape (also returned by `GET /orders/:orderId`):

```json
{
  "id": "5b10953c-f46e-45ed-a23a-ae8f1f97721e",
  "cartId": "089c765a-fabd-4ba5-98bb-73f6487b81cd",
  "status": "PLACED",
  "currency": "USD",
  "lines": [
    { "productId": "sku_hoodie", "productName": "Zip Hoodie", "unitPriceCents": 5999,
      "quantity": 1, "lineTotalCents": 5999 }
  ],
  "subtotalCents": 5999,
  "discount": { "couponCode": "SAVE-8JBX9XKS", "percent": 10, "amountCents": 599 },
  "totalCents": 5400,
  "createdAt": "2026-10-31T10:12:44.120Z"
}
```

`discount` is `null` when no coupon was used. `discount.amountCents = floor(subtotalCents * percent / 100)`.

| Error | When |
|---|---|
| 400 `VALIDATION_ERROR` | malformed body, wrong types, unknown fields |
| 404 `CART_NOT_FOUND` | unknown or malformed cart id |
| 409 `CART_ALREADY_CHECKED_OUT` | cart already checked out with a **different** fingerprint. `details.existingOrderId` |
| 422 `CART_EMPTY` | no items |
| 409 `INSUFFICIENT_INVENTORY` | any line exceeds stock; all shortfalls listed |
| 422 `COUPON_NOT_FOUND` | unknown code |
| 409 `COUPON_ALREADY_REDEEMED` | code used by another order |
| 409 `PRICE_CHANGED` | `details = {expectedTotalCents, actualTotalCents, subtotalCents, discountCents, lines}` |

Check order: replay → empty → stock → coupon → expected total. Any failure leaves **nothing** changed: stock, cart status and coupon status are all rolled back. Failed attempts are not cached, so a retry re-evaluates.

### `GET /orders/:orderId`

**200** order (shape above). Reads only the stored snapshot, never live product data. Errors: 404 `ORDER_NOT_FOUND`.

---

## Admin

### `POST /admin/coupons` (admin)

No body. Creates **one** coupon for the lowest unrewarded milestone that has been reached (milestone k is reached when placed orders ≥ k × n).

**201**

```json
{ "code": "SAVE-8JBX9XKS", "milestone": 1, "percent": 10, "status": "AVAILABLE",
  "createdAt": "2026-10-31T10:12:40.001Z" }
```

`percent` is snapshotted from config at generation time. Codes are `SAVE-` plus 8 characters from an alphabet without 0/O/1/I.

| Error | When |
|---|---|
| 409 `NO_ELIGIBLE_MILESTONE` | `details = {n, ordersPlaced, nextMilestone, ordersUntilNextMilestone}` |

### `GET /admin/coupons` (admin)

**200**, ordered by milestone:

```json
[{ "code": "SAVE-8JBX9XKS", "milestone": 1, "percent": 10, "status": "REDEEMED",
   "createdAt": "...", "redeemedAt": "..." }]
```

### `GET /admin/report` (admin)

**200**. Computed on demand in one `REPEATABLE READ, READ ONLY` transaction; calling it never writes.

Example: the state at the end of `requests.http`.

```json
{
  "currency": "USD",
  "totalOrders": 6,
  "grossRevenueCents": 16693,
  "totalDiscountCents": 599,
  "netRevenueCents": 16094,
  "productsSold": [
    { "productId": "sku_hoodie", "name": "Zip Hoodie", "quantity": 1, "grossCents": 5999 },
    { "productId": "sku_mug", "name": "Ceramic Mug", "quantity": 2, "grossCents": 2598 },
    { "productId": "sku_print", "name": "Limited Edition Print", "quantity": 1, "grossCents": 4999 },
    { "productId": "sku_sticker", "name": "Sticker Pack", "quantity": 3, "grossCents": 597 },
    { "productId": "sku_tee", "name": "Classic Tee", "quantity": 1, "grossCents": 2500 }
  ],
  "coupons": { "generated": 1, "available": 0, "redeemed": 1 },
  "milestones": { "n": 5, "percent": 10, "ordersUntilNextMilestone": 4,
                  "eligibleUngeneratedMilestones": 0 }
}
```

- `grossRevenueCents` = Σ order subtotals; `netRevenueCents` = Σ order totals = gross − discounts.
- `productsSold` comes from order lines, ordered by `productId`. `grossCents` is before discounts (discounts are per order, not per line). `name` is from the most recent order's snapshot.
- `milestones.ordersUntilNextMilestone`: orders still needed to reach the next milestone not yet reached.
- `milestones.eligibleUngeneratedMilestones`: milestones reached with no coupon yet (each needs one `POST /admin/coupons`).
- `percent` here is the **current** config value. Each coupon carries its own snapshotted percent.

---

## Where the code and CLAUDE.md differ (or CLAUDE.md is silent)

1. **`NOT_FOUND` (404)** for unknown routes is an extra code, not in the CLAUDE.md table.
2. **Fastify's own client errors** (malformed or empty JSON body, unsupported content type, body too large) are all mapped to **400 `VALIDATION_ERROR`**, including cases that would normally be 413/415.
3. **Unknown fields in the checkout body are rejected (400).** CLAUDE.md doesn't say. Chosen so a typo can't silently drop a coupon.
4. **An empty or whitespace-only `couponCode`** is treated as "no coupon" (fingerprint `null`), not as an unknown code.
5. **Malformed UUIDs** for carts and orders return 404 (the TASKS.md spec), not 400.
6. **`itemCount`** is total units. CLAUDE.md doesn't define it.
7. **`DELETE` with an unknown product** returns 200 (idempotent delete), not 422 `PRODUCT_NOT_FOUND`.
8. **Extra DB constraints** beyond CLAUDE.md: `carts_checked_out_at_matches_status` and `orders_coupon_snapshot_complete` (coupon id, code and percent are all set or all null).
9. **Coupon-generation retry is bounded at 3 attempts.** With ≥ 3 pending milestones and ≥ 4 simultaneous admin calls, one call can lose three races and surface the unique violation as a 500. Not reachable in normal use; noted as deferred.
10. **Stack:** Vitest is pinned to v3, because Vitest 4+ requires Node 22, while CLAUDE.md promises Node 20+.
