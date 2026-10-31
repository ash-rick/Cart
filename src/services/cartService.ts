import { withTransaction, type DbClient, type Pool } from '../db';
import { errors } from '../errors';
import { lineTotal, sumCents } from '../money';

export interface ProductView {
  id: string;
  name: string;
  priceCents: number;
  stock: number;
}

export interface CartItemView {
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
  availableStock: number;
  inStock: boolean;
}

export interface CartWarning {
  code: 'INSUFFICIENT_INVENTORY';
  productId: string;
  requested: number;
  available: number;
}

export interface CartView {
  id: string;
  status: 'OPEN' | 'CHECKED_OUT';
  currency: 'USD';
  items: CartItemView[];
  itemCount: number;
  subtotalCents: number;
  warnings: CartWarning[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id cannot name an existing cart, so it is a 404, not a 400 or a pg cast error. */
export function assertCartId(cartId: string): void {
  if (!UUID_RE.test(cartId)) throw errors.cartNotFound(cartId);
}

type Queryable = Pool | DbClient;

export async function listProducts(db: Queryable): Promise<ProductView[]> {
  const { rows } = await db.query<ProductView>(
    `SELECT id, name, price_cents AS "priceCents", stock FROM products ORDER BY id`,
  );
  return rows;
}

export async function createCart(pool: Pool): Promise<CartView> {
  const { rows } = await pool.query<{ id: string }>(`INSERT INTO carts DEFAULT VALUES RETURNING id`);
  return loadCartView(pool, rows[0]!.id);
}

export async function getCart(pool: Pool, cartId: string): Promise<CartView> {
  assertCartId(cartId);
  return loadCartView(pool, cartId);
}

/**
 * Sets the absolute quantity of a product in the cart (upsert), so retrying the same PUT
 * is harmless. The stock check here is advisory only: nothing is reserved, and checkout
 * re-checks stock under lock.
 */
export async function setItemQuantity(
  pool: Pool,
  cartId: string,
  productId: string,
  quantity: number,
): Promise<CartView> {
  assertCartId(cartId);
  return withTransaction(pool, async (client) => {
    await lockOpenCart(client, cartId);

    const product = await client.query<{ stock: number }>(
      `SELECT stock FROM products WHERE id = $1`,
      [productId],
    );
    const row = product.rows[0];
    if (!row) throw errors.productNotFound(productId);
    if (quantity > row.stock) {
      throw errors.insufficientInventory([{ productId, requested: quantity, available: row.stock }]);
    }

    await client.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [cartId, productId, quantity],
    );
    await client.query(`UPDATE carts SET updated_at = now() WHERE id = $1`, [cartId]);
    return loadCartView(client, cartId);
  });
}

/** Idempotent: removing an item that is not in the cart still returns 200 with the cart. */
export async function removeItem(pool: Pool, cartId: string, productId: string): Promise<CartView> {
  assertCartId(cartId);
  return withTransaction(pool, async (client) => {
    await lockOpenCart(client, cartId);
    const deleted = await client.query(
      `DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2`,
      [cartId, productId],
    );
    if (deleted.rowCount) {
      await client.query(`UPDATE carts SET updated_at = now() WHERE id = $1`, [cartId]);
    }
    return loadCartView(client, cartId);
  });
}

/**
 * Locks the cart row and requires it to be OPEN.
 *
 * Checkout takes the same row lock (SELECT ... FOR UPDATE) as its first step and holds it
 * until it commits. So an edit and a checkout on the same cart are serialized:
 * - if the edit locks first, checkout waits, then reads the edited items;
 * - if checkout locks first, the edit waits, then re-reads status = 'CHECKED_OUT' (under
 *   READ COMMITTED, FOR UPDATE returns the latest committed row) and fails with 409.
 * Without the lock, an edit could land after checkout read the items but before it
 * committed, and the order would silently not match the cart.
 */
async function lockOpenCart(client: DbClient, cartId: string): Promise<void> {
  const { rows } = await client.query<{ status: string }>(
    `SELECT status FROM carts WHERE id = $1 FOR UPDATE`,
    [cartId],
  );
  const cart = rows[0];
  if (!cart) throw errors.cartNotFound(cartId);
  if (cart.status !== 'OPEN') throw errors.cartAlreadyCheckedOut(cartId);
}

/** Cart view with live prices and stock, read from products at view time. */
async function loadCartView(db: Queryable, cartId: string): Promise<CartView> {
  const cart = await db.query<{ id: string; status: CartView['status'] }>(
    `SELECT id, status FROM carts WHERE id = $1`,
    [cartId],
  );
  const cartRow = cart.rows[0];
  if (!cartRow) throw errors.cartNotFound(cartId);

  const { rows } = await db.query<{
    productId: string;
    name: string;
    unitPriceCents: number;
    quantity: number;
    stock: number;
  }>(
    `SELECT ci.product_id AS "productId", p.name, p.price_cents AS "unitPriceCents",
            ci.quantity, p.stock
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = $1
      ORDER BY ci.product_id`,
    [cartId],
  );

  const items: CartItemView[] = rows.map((r) => ({
    productId: r.productId,
    name: r.name,
    unitPriceCents: r.unitPriceCents,
    quantity: r.quantity,
    lineTotalCents: lineTotal(r.unitPriceCents, r.quantity),
    availableStock: r.stock,
    inStock: r.quantity <= r.stock,
  }));
  const warnings: CartWarning[] = rows
    .filter((r) => r.quantity > r.stock)
    .map((r) => ({
      code: 'INSUFFICIENT_INVENTORY',
      productId: r.productId,
      requested: r.quantity,
      available: r.stock,
    }));

  return {
    id: cartRow.id,
    status: cartRow.status,
    currency: 'USD',
    items,
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
    subtotalCents: sumCents(items.map((i) => i.lineTotalCents)),
    warnings,
  };
}
