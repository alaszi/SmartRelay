import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-client';
import { ApiError } from '@/lib/api-shared';

export interface RelayFormProps {
  relayId: string;
  configPublic: Record<string, unknown>;
  /** Whether a secret is already stored (drives SecretInput's masked "Replace" state). */
  hasSecret: boolean;
  onSaved: () => void;
}

/** Saves a relay's destination config (wizard step 3 / the edit page). Only sends `configSecret`
 * when the caller actually replaced it, since secrets are write-only (MASTER_PLAN section 8.1). */
export async function saveRelayConfig(
  relayId: string,
  configPublic: Record<string, unknown>,
  configSecret: Record<string, unknown> | undefined,
): Promise<boolean> {
  try {
    await apiFetch(`/api/relays/${relayId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        configPublic,
        ...(configSecret ? { configSecret } : {}),
      }),
    });
    toast.success('Saved');
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.fields) {
      for (const message of Object.values(error.fields)) toast.error(message);
    } else {
      toast.error(error instanceof ApiError ? error.message : 'Could not save the relay');
    }
    return false;
  }
}
