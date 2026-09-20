import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run queries: the database itself or a transaction. */
export type Executor = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function createDb(connectionString: string, options: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  // Idle clients can emit errors (e.g. the server restarts); without a listener that crashes the process.
  pool.on('error', (error) => {
    process.stderr.write(`db pool error: ${error.message}\n`);
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
