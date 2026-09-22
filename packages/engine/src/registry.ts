import { webhookSmsModule } from './module-webhook-sms';
import type { ModuleRegistry } from './module';

/**
 * The single source of truth for which module adapters are live in production. Both apps/api
 * (ingest: resolves price, validates config) and apps/worker (deliver: runs the adapter) must use
 * the exact same registry, so this lives here rather than being duplicated or, worse, imported by
 * one app from the other's source (see git history: that broke the app/worker package boundary).
 * A relay type with no entry here reports MODULE_NOT_IMPLEMENTED until its Phase 3 adapter ships.
 */
export function createProductionModuleRegistry(): ModuleRegistry {
  return {
    webhook_sms: webhookSmsModule,
  };
}
