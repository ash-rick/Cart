import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, db, resetDb } from './helpers';

// These tests bypass the service layer on purpose: they prove the database itself
// refuses invariant-breaking writes, even if application code has a bug.

async function expectViolation(sql: string, params: unknown[], constraint: string): Promise<void> {
  await expect(db().query(sql, params)).rejects.toMatchObject({ constraint });
}

async function insertCart(): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO carts (status, checked_out_at) VALUES ('CHECKED_OUT', now()) RETURNING id`,
  );
  return rows[0]!.id;
}

async function insertCoupon(milestone: number): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    `INSERT INTO coupons (code, milestone, percent) VALUES ($1, $2, 10) RETURNING id`,
    [`SAVE-TEST${milestone}`, milestone],
  );
  return rows[0]!.id;
}

const insertOrder = `
  INSERT INTO orders (cart_id, subtotal_cents, discount_cents, total_cents,
                      coupon_id, coupon_code, discount_percent)
  VALUES ($1, $2, $3, $4, $5, $6, $7)`;

describe('schema constraints', () => {
  beforeEach(resetDb);
  afterAll(closeDb);

  it('rejects negative stock (I1)', async () => {
    await expectViolation(
      `UPDATE products SET stock = stock - 4 WHERE id = 'sku_print'`,
      [],
      'products_stock_nonnegative',
    );
  });

  it('rejects a second order for the same cart (I2)', async () => {
    const cartId = await insertCart();
    await db().query(insertOrder, [cartId, 100, 0, 100, null, null, null]);
    await expectViolation(insertOrder, [cartId, 100, 0, 100, null, null, null], 'orders_cart_id_unique');
  });

  it('rejects two orders using the same coupon (I4)', async () => {
    const couponId = await insertCoupon(1);
    await db().query(insertOrder, [await insertCart(), 1000, 100, 900, couponId, 'SAVE-TEST1', 10]);
    await expectViolation(
      insertOrder,
      [await insertCart(), 1000, 100, 900, couponId, 'SAVE-TEST1', 10],
      'orders_coupon_id_unique',
    );
  });

  it('rejects two coupons for the same milestone (I5)', async () => {
    await insertCoupon(1);
    await expectViolation(
      `INSERT INTO coupons (code, milestone, percent) VALUES ('SAVE-OTHER', 1, 10)`,
      [],
      'coupons_milestone_unique',
    );
  });

  it('rejects an order whose total is not subtotal - discount (I6)', async () => {
    const couponId = await insertCoupon(1);
    await expectViolation(
      insertOrder,
      [await insertCart(), 1000, 100, 1000, couponId, 'SAVE-TEST1', 10],
      'orders_total_is_subtotal_minus_discount',
    );
  });

  it('rejects a discount larger than the subtotal (I6)', async () => {
    const couponId = await insertCoupon(1);
    // total = subtotal - discount holds (-100) but is negative; either check may fire first.
    await expect(
      db().query(insertOrder, [await insertCart(), 100, 200, -100, couponId, 'SAVE-TEST1', 10]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
