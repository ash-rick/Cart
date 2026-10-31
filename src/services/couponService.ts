import { randomBytes } from 'node:crypto';
import type { Config } from '../config';
import { withTransaction, type DbClient, type Pool } from '../db';
import { errors } from '../errors';

export interface CouponView {
  code: string;
  milestone: number;
  percent: number;
  status: 'AVAILABLE' | 'REDEEMED';
  createdAt: string;
}

export interface CouponListItem extends CouponView {
  redeemedAt: string | null;
}

const MAX_ATTEMPTS = 3;

// No 0/O or 1/I, so codes survive being read aloud or retyped. 32 symbols divide 256
// evenly, so `byte % 32` is unbiased.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateCode(): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (const b of bytes) suffix += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `SAVE-${suffix}`;
}

export interface MilestoneProgress {
  n: number;
  ordersPlaced: number;
  nextMilestone: number;
  ordersUntilNextMilestone: number;
}

/**
 * Creates one coupon for the lowest unrewarded milestone that has been reached.
 *
 * Two concurrent calls can both compute the same nextMilestone. The UNIQUE(milestone)
 * constraint, not this code, is what stops both from inserting it: the loser gets a
 * unique violation (23505), its transaction is rolled back, and the whole thing is retried.
 * The retry re-reads MAX(milestone) and may legitimately pick the NEXT milestone if
 * several are pending.
 *
 * Why a stale order count is safe under READ COMMITTED: COUNT(*) may miss an order that
 * commits a moment later. Orders are never deleted, so the count we read is only ever
 * lower than the truth. A low count can make us answer "not eligible yet" slightly early,
 * which the admin can simply retry; it can never make us generate a coupon for a
 * milestone that has not been reached.
 */
export async function generateCoupon(pool: Pool, config: Config): Promise<CouponView> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransaction(pool, async (client) => {
        const progress = await milestoneProgress(client, config.couponEveryNOrders);
        if (progress.ordersUntilNextMilestone > 0) {
          throw errors.noEligibleMilestone({ ...progress });
        }
        const { rows } = await client.query<{
          code: string;
          milestone: number;
          percent: number;
          status: CouponView['status'];
          createdAt: Date;
        }>(
          `INSERT INTO coupons (code, milestone, percent, status)
           VALUES ($1, $2, $3, 'AVAILABLE')
           RETURNING code, milestone, percent, status, created_at AS "createdAt"`,
          [generateCode(), progress.nextMilestone, config.couponPercent],
        );
        const c = rows[0]!;
        return { ...c, createdAt: c.createdAt.toISOString() };
      });
    } catch (err) {
      // Lost the race for this milestone (or, astronomically unlikely, a code collision).
      if (isUniqueViolation(err) && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }
  }
}

async function milestoneProgress(
  db: Pool | DbClient,
  n: number,
): Promise<MilestoneProgress> {
  const { rows } = await db.query<{ ordersPlaced: number; nextMilestone: number }>(
    `SELECT (SELECT COUNT(*) FROM orders) AS "ordersPlaced",
            (SELECT COALESCE(MAX(milestone), 0) + 1 FROM coupons) AS "nextMilestone"`,
  );
  const { ordersPlaced, nextMilestone } = rows[0]!;
  return {
    n,
    ordersPlaced,
    nextMilestone,
    ordersUntilNextMilestone: Math.max(nextMilestone * n - ordersPlaced, 0),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === '23505' &&
    'constraint' in err &&
    (err.constraint === 'coupons_milestone_unique' || err.constraint === 'coupons_code_unique')
  );
}

export async function listCoupons(pool: Pool): Promise<CouponListItem[]> {
  const { rows } = await pool.query<{
    code: string;
    milestone: number;
    percent: number;
    status: CouponView['status'];
    createdAt: Date;
    redeemedAt: Date | null;
  }>(
    `SELECT code, milestone, percent, status, created_at AS "createdAt", redeemed_at AS "redeemedAt"
       FROM coupons ORDER BY milestone`,
  );
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    redeemedAt: r.redeemedAt?.toISOString() ?? null,
  }));
}
