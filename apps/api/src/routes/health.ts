import { sql } from 'drizzle-orm';
import type { App } from '../app';

export function registerHealthRoutes(app: App): void {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const [dbOk, redisOk] = await Promise.all([
      app.ctx.db
        .execute(sql`SELECT 1`)
        .then(() => true)
        .catch(() => false),
      app.ctx.redis
        .ping()
        .then(() => true)
        .catch(() => false),
    ]);

    if (!dbOk || !redisOk) {
      reply.status(503);
      return { status: 'unavailable', db: dbOk, redis: redisOk };
    }
    return { status: 'ok', db: true, redis: true };
  });
}
