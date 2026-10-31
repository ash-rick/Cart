import pg from 'pg';

const INT8_OID = 20;

/**
 * BIGINT columns (money, COUNT(*), SUM(...)::bigint) arrive as strings by default.
 * Convert them to number, but refuse anything that would lose precision.
 */
export function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`int8 value ${value} is not a safe integer`);
  }
  return n;
}

pg.types.setTypeParser(INT8_OID, parseInt8);

export type Pool = pg.Pool;
export type DbClient = pg.PoolClient;

export function createPool(connectionString: string): pg.Pool {
  // max 20: concurrency tests fire 20+ requests at once and must not just queue on one connection.
  return new pg.Pool({ connectionString, max: 20 });
}

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

export interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  readOnly?: boolean;
}

/**
 * Runs fn inside BEGIN ... COMMIT on one pooled client. Any throw (including a failed
 * BEGIN or COMMIT) rolls back and rethrows. The client is always released; if ROLLBACK
 * itself fails the connection is in an unknown state, so it is destroyed (release(err))
 * instead of going back to the pool.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: DbClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const modes = [
    options.isolationLevel ? `ISOLATION LEVEL ${options.isolationLevel}` : null,
    options.readOnly ? 'READ ONLY' : null,
  ].filter(Boolean);
  const client = await pool.connect();
  let brokenConnection: Error | undefined;
  try {
    await client.query(modes.length ? `BEGIN ${modes.join(' ')}` : 'BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      brokenConnection = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(brokenConnection);
  }
}
