import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'db', 'migrations');
const seedFile = path.join(root, 'db', 'seed.sql');

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Applies db/migrations/*.sql in filename order, each in its own transaction. */
export async function migrate(url: string): Promise<string[]> {
  return withClient(url, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const file of files) {
      await client.query('BEGIN');
      try {
        // Lock so two concurrent migrators cannot both apply the same file.
        await client.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
        const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
        if (done.rowCount === 0) {
          await client.query(await readFile(path.join(migrationsDir, file), 'utf8'));
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          applied.push(file);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return applied;
  });
}

export async function seed(url: string): Promise<void> {
  const sql = await readFile(seedFile, 'utf8');
  await withClient(url, (client) => client.query(sql));
}

/** Drops and recreates the public schema, then migrates and seeds. Destroys all data. */
export async function reset(url: string): Promise<void> {
  await withClient(url, (client) =>
    client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'),
  );
  await migrate(url);
  await seed(url);
}

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set (copy .env.example to .env).');
    process.exit(1);
  }
  return url;
}

export function redact(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');
}
