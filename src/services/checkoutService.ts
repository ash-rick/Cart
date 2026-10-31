import { withTransaction, type DbClient, type Pool } from '../db';
import { errors, type Shortfall } from '../errors';
import { lineTotal, sumCents } from '../money';
import { assertCartId, isUuid } from './cartService';

export interface CheckoutInput {
  cartId: string;
  couponCode?: string;
  expectedTotalCents?: number;
}

export interface OrderLineView {
  productId: string;
  productName: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface OrderView {
  id: string;
  cartId: string;
  status: 'PLACED';
  currency: 'USD';
  lines: OrderLineView[];
  subtotalCents: number;
  discount: null | { couponCode: string; percent: number; amountCents: number };
  totalCents: number;
  createdAt: string;
}

export interface CheckoutResult {
  order: OrderView;
  replayed: boolean;
}

/** Coupon codes are case-insensitive and tolerant of surrounding whitespace. */
export function normalizeCouponCode(code: string | undefined): string | null {
  const trimmed = code?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

/**
 * What makes two checkout requests for the same cart "the same request". Only the
 * coupon matters: expectedTotalCents is a client-side guard, not part of the intent.
 */
function fingerprintOf(couponCode: string | null): string {
  return JSON.stringify({ couponCode });
}

/**
 * Places an order for the cart. Everything happens in ONE transaction, so any thrown
 * error (stock, price, coupon, constraint) rolls back every write, including the coupon
 * claim and stock decrements.
 *
 * Lock order is fixed to prevent deadlocks: cart row -> product rows by id ascending ->
 * coupon row.
 */
export async function checkout(pool: Pool, input: CheckoutInput): Promise<CheckoutResult> {
  assertCartId(input.cartId);
  const couponCode = normalizeCouponCode(input.couponCode);
  const fingerprint = fingerprintOf(couponCode);

  return withTransaction(pool, async (client) => {
    // STEP 1: lock the cart. Concurrent checkouts/edits of this cart queue here. This
    // replay check must come before any stock check: a retry of a successful checkout
    // must return the order even if stock has since run out.
    const cartRes = await client.query<{ status: 'OPEN' | 'CHECKED_OUT' }>(
      `SELECT status FROM carts WHERE id = $1 FOR UPDATE`,
      [input.cartId],
    );
    const cart = cartRes.rows[0];
    if (!cart) throw errors.cartNotFound(input.cartId);
    if (cart.status === 'CHECKED_OUT') {
      return replayExistingOrder(client, input.cartId, fingerprint);
    }

    // STEP 2: the cart's items. Safe to read now: edits need the cart lock we hold.
    const itemsRes = await client.query<{ productId: string; quantity: number }>(
      `SELECT product_id AS "productId", quantity FROM cart_items WHERE cart_id = $1`,
      [input.cartId],
    );
    if (itemsRes.rows.length === 0) throw errors.cartEmpty(input.cartId);
    const quantities = new Map(itemsRes.rows.map((r) => [r.productId, r.quantity]));

    // STEP 3: lock the products in id order. Under READ COMMITTED, FOR UPDATE waits for
    // any concurrent checkout holding these rows and then returns their committed stock,
    // so the check below never uses a stale value.
    const productsRes = await client.query<{
      id: string;
      name: string;
      priceCents: number;
      stock: number;
    }>(
      `SELECT id, name, price_cents AS "priceCents", stock
         FROM products
        WHERE id = ANY($1::text[])
        ORDER BY id
          FOR UPDATE`,
      [[...quantities.keys()]],
    );

    // STEP 4: check stock for every line (report all shortfalls) and price at current prices.
    const shortfalls: Shortfall[] = [];
    const lines: OrderLineView[] = productsRes.rows.map((p) => {
      const quantity = quantities.get(p.id)!;
      if (quantity > p.stock) {
        shortfalls.push({ productId: p.id, requested: quantity, available: p.stock });
      }
      return {
        productId: p.id,
        productName: p.name,
        unitPriceCents: p.priceCents,
        quantity,
        lineTotalCents: lineTotal(p.priceCents, quantity),
      };
    });
    if (shortfalls.length > 0) throw errors.insufficientInventory(shortfalls);
    const subtotalCents = sumCents(lines.map((l) => l.lineTotalCents));

    // STEP 5: coupon claim (Task 8)
    if (couponCode !== null) throw errors.couponNotFound(couponCode);
    const discountCents = 0;
    const totalCents = subtotalCents - discountCents;

    // STEP 6: the client may pin the total it saw; refuse to charge anything else.
    if (input.expectedTotalCents !== undefined && input.expectedTotalCents !== totalCents) {
      throw errors.priceChanged({
        expectedTotalCents: input.expectedTotalCents,
        actualTotalCents: totalCents,
        subtotalCents,
        discountCents,
        lines,
      });
    }

    // STEP 7: write the order snapshot, decrement stock, close the cart.
    const orderRes = await client.query<{ id: string }>(
      `INSERT INTO orders (cart_id, subtotal_cents, discount_cents, total_cents, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [input.cartId, subtotalCents, discountCents, totalCents, fingerprint],
    );
    const orderId = orderRes.rows[0]!.id;

    await client.query(
      `INSERT INTO order_lines
         (order_id, product_id, product_name, unit_price_cents, quantity, line_total_cents)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::bigint[], $5::int[], $6::bigint[])`,
      [
        orderId,
        lines.map((l) => l.productId),
        lines.map((l) => l.productName),
        lines.map((l) => l.unitPriceCents),
        lines.map((l) => l.quantity),
        lines.map((l) => l.lineTotalCents),
      ],
    );

    // The rows are already locked, so this cannot race; CHECK (stock >= 0) is the backstop.
    await client.query(
      `UPDATE products p
          SET stock = p.stock - v.quantity, updated_at = now()
         FROM unnest($1::text[], $2::int[]) AS v(product_id, quantity)
        WHERE p.id = v.product_id`,
      [lines.map((l) => l.productId), lines.map((l) => l.quantity)],
    );

    await client.query(
      `UPDATE carts SET status = 'CHECKED_OUT', checked_out_at = now(), updated_at = now()
        WHERE id = $1`,
      [input.cartId],
    );

    // STEP 8: commit happens in withTransaction when this returns.
    return { order: await loadOrder(client, orderId), replayed: false };
  });
}

async function replayExistingOrder(
  client: DbClient,
  cartId: string,
  fingerprint: string,
): Promise<CheckoutResult> {
  const { rows } = await client.query<{ id: string; fingerprint: string | null }>(
    `SELECT id, request_fingerprint AS fingerprint FROM orders WHERE cart_id = $1`,
    [cartId],
  );
  const existing = rows[0];
  if (!existing) {
    // Cannot happen: the order and the status change commit together.
    throw new Error(`cart ${cartId} is CHECKED_OUT but has no order`);
  }
  if (existing.fingerprint !== fingerprint) {
    throw errors.cartAlreadyCheckedOut(cartId, { existingOrderId: existing.id });
  }
  return { order: await loadOrder(client, existing.id), replayed: true };
}

export async function getOrder(pool: Pool, orderId: string): Promise<OrderView> {
  if (!isUuid(orderId)) throw errors.orderNotFound(orderId);
  return loadOrder(pool, orderId);
}

/** Reads ONLY orders and order_lines (I7): an order never reflects later product changes. */
async function loadOrder(db: Pool | DbClient, orderId: string): Promise<OrderView> {
  const orderRes = await db.query<{
    id: string;
    cartId: string;
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
    couponCode: string | null;
    discountPercent: number | null;
    createdAt: Date;
  }>(
    `SELECT id, cart_id AS "cartId", subtotal_cents AS "subtotalCents",
            discount_cents AS "discountCents", total_cents AS "totalCents",
            coupon_code AS "couponCode", discount_percent AS "discountPercent",
            created_at AS "createdAt"
       FROM orders WHERE id = $1`,
    [orderId],
  );
  const o = orderRes.rows[0];
  if (!o) throw errors.orderNotFound(orderId);

  const linesRes = await db.query<OrderLineView>(
    `SELECT product_id AS "productId", product_name AS "productName",
            unit_price_cents AS "unitPriceCents", quantity, line_total_cents AS "lineTotalCents"
       FROM order_lines WHERE order_id = $1 ORDER BY product_id`,
    [orderId],
  );

  return {
    id: o.id,
    cartId: o.cartId,
    status: 'PLACED',
    currency: 'USD',
    lines: linesRes.rows,
    subtotalCents: o.subtotalCents,
    discount:
      o.couponCode !== null && o.discountPercent !== null
        ? { couponCode: o.couponCode, percent: o.discountPercent, amountCents: o.discountCents }
        : null,
    totalCents: o.totalCents,
    createdAt: o.createdAt.toISOString(),
  };
}
