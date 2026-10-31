import { describe, expect, it } from 'vitest';
import { assertCents, lineTotal, percentDiscount, sumCents } from '../src/money';

describe('percentDiscount', () => {
  it.each([
    // subtotal, percent, expected      why
    [1299, 10, 129], //                  129.9  -> 129 (floor, customer-favourable)
    [199, 10, 19], //                    19.9   -> 19
    [5, 10, 0], //                       0.5    -> 0: tiny orders get no discount
    [999, 33, 329], //                   329.67 -> 329
    [1000, 100, 1000], //                100% off equals the subtotal, never more
    [0, 10, 0],
    [2500, 10, 250], //                  exact, no rounding
    [4999, 15, 749], //                  749.85 -> 749
  ])('discount(%i, %i) = %i', (subtotal, percent, expected) => {
    expect(percentDiscount(subtotal, percent)).toBe(expected);
  });

  it.each([0, 101, -5, 10.5, Number.NaN])('rejects percent %s', (percent) => {
    expect(() => percentDiscount(1000, percent)).toThrow(RangeError);
  });

  it.each([-1, 10.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects subtotal %s', (subtotal) => {
    expect(() => percentDiscount(subtotal, 10)).toThrow(RangeError);
  });

  it('never exceeds the subtotal and never goes negative', () => {
    // Deterministic pseudo-random subtotals so a failure is reproducible.
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    for (let i = 0; i < 5000; i++) {
      const subtotal = next() % 10_000_000;
      const percent = (next() % 100) + 1;
      const discount = percentDiscount(subtotal, percent);
      expect(Number.isSafeInteger(discount)).toBe(true);
      expect(discount).toBeGreaterThanOrEqual(0);
      expect(discount).toBeLessThanOrEqual(subtotal);
      expect(discount).toBe(Math.floor((subtotal * percent) / 100));
    }
  });
});

describe('lineTotal / sumCents / assertCents', () => {
  it('multiplies unit price by quantity exactly', () => {
    expect(lineTotal(1299, 3)).toBe(3897);
    expect(lineTotal(0, 5)).toBe(0);
  });

  it('rejects floats and non-positive quantities', () => {
    expect(() => lineTotal(12.99, 1)).toThrow(RangeError);
    expect(() => lineTotal(1299, 0)).toThrow(RangeError);
    expect(() => lineTotal(1299, 1.5)).toThrow(RangeError);
  });

  it('sums integer cents, and rejects floats and negatives', () => {
    expect(sumCents([2500, 1299, 199])).toBe(3998);
    expect(sumCents([])).toBe(0);
    expect(() => sumCents([100, 0.1])).toThrow(RangeError);
    expect(() => sumCents([100, -1])).toThrow(RangeError);
  });

  it('assertCents accepts only non-negative safe integers', () => {
    expect(assertCents(0)).toBe(0);
    expect(() => assertCents(0.1 + 0.2)).toThrow(RangeError);
    expect(() => assertCents(-1)).toThrow(RangeError);
  });
});
