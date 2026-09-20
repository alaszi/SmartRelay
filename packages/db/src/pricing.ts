import { eq } from 'drizzle-orm';
import { DEFAULT_PRICES_MICRO, PRICING_KINDS, type PricingKind } from '@smartrelay/shared';
import type { Executor } from './client';
import { pricing } from './schema';

/** Inserts the default prices. Existing rows are left alone so an owner-changed price survives. */
export async function seedPricing(db: Executor): Promise<void> {
  await db
    .insert(pricing)
    .values(PRICING_KINDS.map((kind) => ({ kind, priceMicro: DEFAULT_PRICES_MICRO[kind] })))
    .onConflictDoNothing();
}

export async function getPriceMicro(db: Executor, kind: PricingKind): Promise<bigint> {
  const [row] = await db.select().from(pricing).where(eq(pricing.kind, kind)).limit(1);
  if (!row) throw new Error(`No price configured for "${kind}". Run the pricing seed.`);
  return row.priceMicro;
}
