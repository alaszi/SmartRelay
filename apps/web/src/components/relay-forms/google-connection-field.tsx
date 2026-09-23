'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { InfoTip } from '@/components/info-tip';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api-client';
import { ApiError } from '@/lib/api-shared';

interface GoogleConnection {
  id: string;
  accountEmail: string;
  createdAt: string;
}

/** Module 4's required "Google connection" field (MASTER_PLAN section 10 — not Advanced).
 * `connected` reflects the relay's own secret (`hasSecret`): calendar_bridge stores only
 * `refreshToken`, so a stored secret means a Google account is attached, though the relay itself
 * does not remember *which* connection it came from (attaching one just copies the token in). */
export function GoogleConnectionField({
  relayId,
  connected,
}: {
  relayId: string;
  connected: boolean;
}) {
  const [connections, setConnections] = useState<GoogleConnection[] | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [isConnected, setIsConnected] = useState(connected);

  useEffect(() => {
    apiFetch<{ connections: GoogleConnection[] }>('/api/oauth/google/connections')
      .then((res) => setConnections(res.connections))
      .catch(() => setConnections([]));
  }, []);

  async function attach(connectionId: string) {
    setAttaching(true);
    try {
      const result = await apiFetch<{ accountEmail: string }>(
        `/api/relays/${relayId}/google-connection`,
        { method: 'POST', body: JSON.stringify({ connectionId }) },
      );
      toast.success(`Connected as ${result.accountEmail}`);
      setIsConnected(true);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not attach the connection');
    } finally {
      setAttaching(false);
    }
  }

  function connectNew() {
    // A full-page navigation, not an XHR: the browser has to actually visit Google's consent
    // screen. Google eventually redirects back to /relays/:relayId?connected=<email>.
    window.location.href = `/api/oauth/google/start?relayId=${relayId}`;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <Label>Google connection</Label>
        <InfoTip title="Grants access only to create events on your primary calendar (the calendar.events scope) — nothing else." />
      </div>
      <p className={isConnected ? 'text-sm text-green-700' : 'text-sm text-amber-700'}>
        {isConnected ? '✓ Connected' : 'Not connected yet'}
      </p>
      {connections && connections.length > 0 ? (
        <select
          defaultValue=""
          disabled={attaching}
          onChange={(event) => {
            if (event.target.value) void attach(event.target.value);
          }}
          className="h-10 rounded-md border border-[var(--border)] bg-white px-3 text-sm"
        >
          <option value="" disabled>
            Use an existing connection…
          </option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.accountEmail}
            </option>
          ))}
        </select>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="self-start"
        onClick={connectNew}
      >
        {isConnected ? 'Reconnect / use a different account' : 'Connect Google'}
      </Button>
    </div>
  );
}
