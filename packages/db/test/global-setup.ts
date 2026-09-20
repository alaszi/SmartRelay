import pg from 'pg';
import { createDb } from '../src/client';
import { runMigrations } from '../src/migrate';
import { testDatabaseUrl } from './helpers';

/** Creates the smartrelay_test database if needed and brings it up to the latest migration. */
export default async function setup(): Promise<void> {
  const target = new URL(testDatabaseUrl());
  const databaseName = decodeURIComponent(target.pathname.slice(1));

  if (!/^[a-z0-9_]+_test$/.test(databaseName)) {
    throw new Error(`Test database name must match [a-z0-9_]+_test, got "${databaseName}"`);
  }

  const adminUrl = new URL(target);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });

  try {
    await admin.connect();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const reason =
      typeof code === 'string' ? code : error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot reach Postgres for integration tests (${reason}). ` +
        'Start it with: docker compose up -d --wait',
      { cause: error },
    );
  }

  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }

  const { db, close } = createDb(target.toString(), { max: 1 });
  try {
    await runMigrations(db);
  } finally {
    await close();
  }
}
