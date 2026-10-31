import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { closeDb, makeApp, resetDb } from './helpers';

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
});
