import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, makeApp, resetDb } from './helpers';

describe('GET /health', () => {
  beforeEach(resetDb);
  afterAll(closeDb);

  it('returns ok when the database is reachable', async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    } finally {
      await app.close();
    }
  });
});
