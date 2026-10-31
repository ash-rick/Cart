import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cartStatus,
  cartWith,
  checkout,
  closeDb,
  couponStatus,
  db,
  issueCoupon,
  makeApp,
  raceBehindTableLock,
  resetDb,
  stockOf,
} from './helpers';

// I4: a coupon is redeemed by at most one committed order.
// Catches: a check-then-act claim (SELECT status, then an unconditional UPDATE). Both
// checkouts would see AVAILABLE and both would "claim" it; the second order then hits
// orders.coupon_id UNIQUE (a 500) or, without that constraint, gets a second discount.
//
// The two carts hold different products, so they contend only on the coupon row.
// raceBehindTableLock holds both checkouts just before the coupon UPDATE, so their
// claims really overlap instead of running one after the other.
describe('concurrent redemption of one coupon', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    app = await makeApp({ couponEveryNOrders: 1 });
  });
  afterEach(() => app.close());
  afterAll(closeDb);

  for (let round = 1; round <= 5; round++) {
    it(`two carts, one coupon: exactly one wins (round ${round})`, async () => {
      const code = await issueCoupon(app);
      const mugCart = await cartWith(app, { sku_mug: 1 });
      const capCart = await cartWith(app, { sku_cap: 1 });

      const [mug, cap] = await raceBehindTableLock('coupons', 2, () =>
        Promise.all([
          checkout(app, mugCart, { couponCode: code }),
          checkout(app, capCart, { couponCode: code }),
        ]),
      );

      expect([mug.statusCode, cap.statusCode].sort()).toEqual([201, 409]);
      const loser = mug.statusCode === 409 ? mug : cap;
      expect(loser.json().error.code).toBe('COUPON_ALREADY_REDEEMED');

      const initialStock = { sku_mug: 50, sku_cap: 40 };
      const [winnerCart, loserCart, winnerSku, loserSku] =
        mug.statusCode === 201
          ? ([mugCart, capCart, 'sku_mug', 'sku_cap'] as const)
          : ([capCart, mugCart, 'sku_cap', 'sku_mug'] as const);
      expect(await cartStatus(winnerCart)).toBe('CHECKED_OUT');
      expect(await cartStatus(loserCart)).toBe('OPEN');
      expect(await stockOf(winnerSku)).toBe(initialStock[winnerSku] - 1);
      expect(await stockOf(loserSku)).toBe(initialStock[loserSku]);

      const { rows } = await db().query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM orders o JOIN coupons c ON c.id = o.coupon_id WHERE c.code = $1`,
        [code],
      );
      expect(rows[0]!.n).toBe(1);
      expect(await couponStatus(code)).toBe('REDEEMED');
    });
  }
});
