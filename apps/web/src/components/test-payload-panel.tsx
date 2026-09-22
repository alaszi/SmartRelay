'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { ApiError } from '@/lib/api-shared';
import type { RelayType } from '@smartrelay/shared';
import { RELAY_TYPE_PRICE } from '@/lib/relay-types';

interface TestResult {
  outcome: {
    kind: 'noop' | 'success' | 'terminal' | 'retry';
    errorCode?: string;
    message?: string;
  };
  event: {
    status: string;
    errorCode: string | null;
    finalStatusCode: number | null;
    cost: string;
  } | null;
}

/** Step 4: "Send Test Payload" (MASTER_PLAN section 10 & decision D9 — a real, billed delivery,
 * flagged source=test). States the cost before sending. */
export function TestPayloadPanel({
  relayId,
  relayType,
  samplePayload,
}: {
  relayId: string;
  relayType: RelayType;
  samplePayload: unknown;
}) {
  const [payloadText, setPayloadText] = useState(JSON.stringify(samplePayload, null, 2));
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  async function handleSend() {
    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      setParseError('Not valid JSON');
      return;
    }
    setParseError(null);
    setSending(true);
    setResult(null);
    try {
      const response = await apiFetch<TestResult>(`/api/relays/${relayId}/test`, {
        method: 'POST',
        body: JSON.stringify({ payload }),
      });
      setResult(response);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not send the test payload');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <textarea
        value={payloadText}
        onChange={(event) => setPayloadText(event.target.value)}
        rows={8}
        className="w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 font-mono text-xs text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
      />
      {parseError ? <p className="text-sm text-red-600">{parseError}</p> : null}
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--muted)]">
          This performs a real delivery and costs{' '}
          <span className="font-medium text-gray-700">{RELAY_TYPE_PRICE[relayType]}</span> on
          success.
        </p>
        <Button type="button" onClick={() => void handleSend()} disabled={sending}>
          {sending ? 'Sending…' : 'Send Test Payload'}
        </Button>
      </div>
      {result ? (
        <div className="rounded-md border border-[var(--border)] bg-gray-50 p-3 text-sm">
          <p className="font-medium text-gray-900">
            {result.outcome.kind === 'success' ? 'Delivered' : result.outcome.kind}
            {result.event?.finalStatusCode ? ` (HTTP ${result.event.finalStatusCode})` : ''}
          </p>
          {result.event?.status === 'SUCCESS' ? (
            <p className="text-gray-600">Charged {result.event.cost}</p>
          ) : null}
          {result.outcome.message ? (
            <p className="mt-1 text-gray-600">{result.outcome.message}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
