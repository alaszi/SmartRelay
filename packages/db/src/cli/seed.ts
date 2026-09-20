import { createDb } from '../client';
import { seedPricing } from '../pricing';

const url = process.env['DATABASE_URL'];
if (!url) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(1);
}

const { db, close } = createDb(url, { max: 1 });
try {
  await seedPricing(db);
  process.stdout.write('pricing seeded\n');
} finally {
  await close();
}
