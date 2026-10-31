import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cartWith, closeDb, createCart, makeApp, resetDb } from './helpers';

describe('error responses', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDb();
    app = await makeApp();
    // Test-only routes that exercise each branch of the error handler.
    app.post('/__test/echo', async (req) => z.object({ quantity: z.number().int() }).parse(req.body));
    app.get('/__test/boom', async () => {
      throw new Error('relation "secret_table" does not exist');
    });
  });
  afterEach(() => app.close());
  afterAll(closeDb);

  it('malformed JSON -> 400 VALIDATION_ERROR with the documented shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.any(String) });
  });

  it('zod failure -> 400 VALIDATION_ERROR with field-level details', async () => {
    const res = await app.inject({ method: 'POST', url: '/__test/echo', payload: { quantity: '2' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { issues: [{ path: 'quantity', message: expect.any(String) }] },
    });
  });

  it('unknown route -> 404 NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('unexpected error -> generic 500 that leaks nothing', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
    expect(res.body).not.toContain('secret_table');
  });

  // Inputs that used to reach Postgres (NUL bytes are invalid in text: 22021) or Fastify's
  // router and came back as 500s or in Fastify's own error shape.
  it.each([
    ['PUT', 'items/a%00b', { quantity: 1 }],
    ['DELETE', 'items/a%00b', undefined],
    ['PUT', `items/${'x'.repeat(150)}`, { quantity: 1 }],
    ['PUT', 'items/sku mug', { quantity: 1 }],
  ])('%s with a malformed product id %# -> 400 VALIDATION_ERROR', async (method, path, payload) => {
    const cartId = await createCart(app);
    const res = await app.inject({
      method: method as 'PUT' | 'DELETE',
      url: `/carts/${cartId}/${path}`,
      ...(payload ? { payload } : {}),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  // 'A\\u0000B' is the JSON escape for a NUL byte: valid JSON, invalid Postgres text.
  it.each(['A\\u0000B','SAVE-AB12!', 'x'.repeat(65)])(
    'checkout with malformed couponCode %# -> 400 VALIDATION_ERROR',
    async (couponCode) => {
      const cartId = await cartWith(app, { sku_mug: 1 });
      const res = await app.inject({
        method: 'POST',
        url: `/carts/${cartId}/checkout`,
        headers: { 'content-type': 'application/json' },
        payload: `{"couponCode":"${couponCode}"}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    },
  );

  it('a URL that is not valid percent-encoding -> 400 in the standard error shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/carts/%E0%A4%A' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});
