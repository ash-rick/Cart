import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cartStatus,
  cartWith,
  checkout,
  closeDb,
  couponStatus,
  db,
  generateCoupon,
  issueCoupon,
  makeApp,
  placeOrders,
  resetDb,
  stockOf,
} from './helpers';

describe('coupon redemption at checkout (n = 3, x = 10)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    app = await makeApp({ couponEveryNOrders: 3, couponPercent: 10 });
  });
  afterEach(() => app.close());
  afterAll(closeDb);

  it('applies floor(subtotal * x / 100), reconciles totals, marks the coupon REDEEMED', async () => {
    const code = await issueCoupon(app);
    const cartId = await cartWith(app, { sku_mug: 1, sku_sticker: 1 }); // 1299 + 199 = 1498

    const res = await checkout(app, cartId, { couponCode: code, expectedTotalCents: 1349 });

    expect(res.statusCode).toBe(201);
    const order = res.json();
    // 1498 * 10 / 100 = 149.8 -> 149
    expect(order).toMatchObject({
      subtotalCents: 1498,
      discount: { couponCode: code, percent: 10, amountCents: 149 },
      totalCents: 1349,
    });
    expect(order.subtotalCents - order.discount.amountCents).toBe(order.totalCents);
    expect(await couponStatus(code)).toBe('REDEEMED');
    const { rows } = await db().query(`SELECT redeemed_at FROM coupons WHERE code = $1`, [code]);
    expect(rows[0].redeemed_at).not.toBeNull();
  });

  it('a checkout that fails on stock does not consume the coupon (I4)', async () => {
    const code = await issueCoupon(app);
    const cartId = await cartWith(app, { sku_print: 3 });
    await db().query(`UPDATE products SET stock = 1 WHERE id = 'sku_print'`);

    const failed = await checkout(app, cartId, { couponCode: code });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error.code).toBe('INSUFFICIENT_INVENTORY');
    expect(await couponStatus(code)).toBe('AVAILABLE');

    const other = await cartWith(app, { sku_mug: 1 });
    const ok = await checkout(app, other, { couponCode: code });
    expect(ok.statusCode).toBe(201);
    expect(await couponStatus(code)).toBe('REDEEMED');
  });

  it('a checkout that fails on PRICE_CHANGED (after the claim) does not consume the coupon', async () => {
    const code = await issueCoupon(app);
    const cartId = await cartWith(app, { sku_mug: 1 });

    // The client expected the undiscounted price; the claim happens, then the check fails.
    const failed = await checkout(app, cartId, { couponCode: code, expectedTotalCents: 1299 });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toMatchObject({
      code: 'PRICE_CHANGED',
      details: { expectedTotalCents: 1299, actualTotalCents: 1170, discountCents: 129 },
    });
    expect(await couponStatus(code)).toBe('AVAILABLE');
    expect(await cartStatus(cartId)).toBe('OPEN');

    const ok = await checkout(app, cartId, { couponCode: code, expectedTotalCents: 1170 });
    expect(ok.statusCode).toBe(201);
  });

  it('unknown code -> 422; reusing a redeemed coupon on another cart -> 409', async () => {
    const unknown = await checkout(app, await cartWith(app, { sku_mug: 1 }), {
      couponCode: 'SAVE-NOPE2345',
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error.code).toBe('COUPON_NOT_FOUND');

    const code = await issueCoupon(app);
    expect((await checkout(app, await cartWith(app, { sku_mug: 1 }), { couponCode: code })).statusCode).toBe(201);

    const reuseCart = await cartWith(app, { sku_cap: 1 });
    const reuse = await checkout(app, reuseCart, { couponCode: code });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error.code).toBe('COUPON_ALREADY_REDEEMED');
    expect(await cartStatus(reuseCart)).toBe('OPEN');
    expect(await stockOf('sku_cap')).toBe(40);
  });

  it('codes are case-insensitive and whitespace-tolerant', async () => {
    const code = await issueCoupon(app);
    const res = await checkout(app, await cartWith(app, { sku_mug: 1 }), {
      couponCode: `  ${code.toLowerCase()} `,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().discount.couponCode).toBe(code);
  });

  it('replaying a coupon checkout returns the original order, not COUPON_ALREADY_REDEEMED', async () => {
    const code = await issueCoupon(app);
    const cartId = await cartWith(app, { sku_mug: 1 });
    const first = await checkout(app, cartId, { couponCode: code });

    // Same fingerprint even though the code is spelled differently.
    const replay = await checkout(app, cartId, { couponCode: code.toLowerCase() });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());

    // Dropping the coupon on retry is a different request.
    const different = await checkout(app, cartId);
    expect(different.statusCode).toBe(409);
    expect(different.json().error.code).toBe('CART_ALREADY_CHECKED_OUT');
  });

  it('a 100% coupon makes the total 0, never negative', async () => {
    await app.close();
    app = await makeApp({ couponEveryNOrders: 3, couponPercent: 100 });
    const code = await issueCoupon(app);

    const res = await checkout(app, await cartWith(app, { sku_hoodie: 1 }), { couponCode: code });
    expect(res.json()).toMatchObject({
      subtotalCents: 5999,
      discount: { percent: 100, amountCents: 5999 },
      totalCents: 0,
    });
  });

  it('orders placed with a coupon count toward the next milestone', async () => {
    const code = await issueCoupon(app); // 3 orders placed, milestone 1 generated
    await placeOrders(app, 2); // 5 orders
    expect((await generateCoupon(app)).statusCode).toBe(409);

    await checkout(app, await cartWith(app, { sku_mug: 1 }), { couponCode: code }); // 6th order
    const res = await generateCoupon(app);
    expect(res.statusCode).toBe(201);
    expect(res.json().milestone).toBe(2);
  });
});
