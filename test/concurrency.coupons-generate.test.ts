import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  countRows,
  db,
  generateCoupon,
  makeApp,
  placeOrders,
  raceBehindTableLock,
  resetDb,
} from './helpers';

// I5: at most one coupon per milestone, and never more coupons than milestones reached.
//
// A plain Promise.all was not enough here: the generate transaction is so short that the
// calls mostly ran one after another, and the test still passed with the retry removed.
// raceBehindTableLock makes all 10 calls read MAX(milestone) before any of them inserts,
// so every call really does try to insert the same milestone.
//
// Catches: removing UNIQUE(milestone) (duplicate milestone-1 coupons) or removing the
// retry on 23505 (the losers surface as 500s instead of a clean 409 / next milestone).
describe('concurrent coupon generation (n = 3)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    app = await makeApp({ couponEveryNOrders: 3 });
  });
  afterEach(() => app.close());
  afterAll(closeDb);

  const tenAtOnce = () => Promise.all(Array.from({ length: 10 }, () => generateCoupon(app)));

  it('3 orders, 10 simultaneous calls -> exactly one coupon', async () => {
    await placeOrders(app, 3);

    const responses = await raceBehindTableLock('coupons', 10, tenAtOnce);

    const created = responses.filter((r) => r.statusCode === 201);
    const refused = responses.filter((r) => r.statusCode === 409);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(9);
    for (const r of refused) expect(r.json().error.code).toBe('NO_ELIGIBLE_MILESTONE');
    expect(created[0]!.json().milestone).toBe(1);
    expect(await countRows('coupons')).toBe(1);
  });

  it('6 orders, 10 simultaneous calls -> exactly milestones 1 and 2', async () => {
    await placeOrders(app, 6);

    const responses = await raceBehindTableLock('coupons', 10, tenAtOnce);

    const created = responses.filter((r) => r.statusCode === 201);
    const refused = responses.filter((r) => r.statusCode === 409);
    expect(created).toHaveLength(2);
    expect(refused).toHaveLength(8);
    expect(created.map((r) => r.json().milestone).sort()).toEqual([1, 2]);
    const { rows } = await db().query<{ milestone: number }>(
      `SELECT milestone FROM coupons ORDER BY milestone`,
    );
    expect(rows.map((r) => r.milestone)).toEqual([1, 2]);
  });
});
