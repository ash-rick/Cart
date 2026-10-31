// Money is always an integer number of cents. These helpers are pure and refuse
// anything that is not a non-negative safe integer, so a float can never sneak in.

export function assertCents(n: number, label = 'amount'): number {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer of cents, got ${n}`);
  }
  return n;
}

function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new RangeError(`quantity must be a positive integer, got ${quantity}`);
  }
}

export function lineTotal(unitPriceCents: number, quantity: number): number {
  assertCents(unitPriceCents, 'unitPriceCents');
  assertQuantity(quantity);
  return assertCents(unitPriceCents * quantity, 'lineTotal');
}

export function sumCents(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    total = assertCents(total + assertCents(v), 'sum');
  }
  return total;
}

/**
 * floor(subtotal * percent / 100), clamped to [0, subtotal].
 * Rounds down, so the customer never pays more than the advertised percent off.
 * Uses exact integer arithmetic: (p - p % 100) / 100 never goes through a fraction.
 */
export function percentDiscount(subtotalCents: number, percent: number): number {
  assertCents(subtotalCents, 'subtotalCents');
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new RangeError(`percent must be an integer from 1 to 100, got ${percent}`);
  }
  const product = assertCents(subtotalCents * percent, 'subtotal * percent');
  const discount = (product - (product % 100)) / 100;
  return Math.min(Math.max(discount, 0), subtotalCents);
}
