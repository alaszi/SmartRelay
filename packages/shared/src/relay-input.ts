import { z } from 'zod';
import { relayTypeSchema } from './enums';

export const MAX_RELAYS_PER_ACCOUNT = 25;

/**
 * Generic request shape for Phase 2 (auth/CRUD plumbing). Phase 3 replaces `configPublic` /
 * `configSecret` validation with each module's own `configSchema` (see packages/engine's
 * RelayModule contract) and the required-vs-Advanced field split from the plan (section 6).
 */
export const createRelayInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: relayTypeSchema,
  /**
   * No default: omitting this entirely (vs. passing `{}`) is what lets the web wizard create a
   * relay right after step 1 (name + type), before its destination config exists, so step 2 can
   * show the generated trigger URL/address while step 3 is still being filled in. The API only
   * validates a config against the module's own schema when the caller actually supplies one
   * (see apps/api/src/routes/relays.ts's assertValidModuleConfig).
   */
  configPublic: z.record(z.string(), z.unknown()).optional(),
  /** Plaintext on input only; the API encrypts it and never returns it. */
  configSecret: z.record(z.string(), z.unknown()).optional(),
});
export type CreateRelayInput = z.infer<typeof createRelayInputSchema>;

export const updateRelayInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  configPublic: z.record(z.string(), z.unknown()).optional(),
  configSecret: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateRelayInput = z.infer<typeof updateRelayInputSchema>;
