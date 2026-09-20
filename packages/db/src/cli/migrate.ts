import { createDb } from '../client';
import { runMigrations } from '../migrate';

const url = process.env['DATABASE_URL'];
if (!url) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(1);
}

const { db, close } = createDb(url, { max: 1 });
try {
  await runMigrations(db);
  process.stdout.write('migrations applied\n');
} finally {
  await close();
}
