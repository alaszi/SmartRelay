'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { CopyField } from '@/components/copy-field';
import { RELAY_FORMS } from '@/components/relay-forms';
import { TestPayloadPanel } from '@/components/test-payload-panel';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api-client';
import { ApiError } from '@/lib/api-shared';
import { RELAY_TYPE_LABELS, type RelaySummary } from '@/lib/relay-types';
import { SAMPLE_PAYLOADS } from '@/lib/sample-payloads';

export function EditRelayView({
  relay: initialRelay,
}: {
  relay: RelaySummary & { emailAddress?: string };
}) {
  const router = useRouter();
  const [relay, setRelay] = useState(initialRelay);
  const [name, setName] = useState(relay.name);
  const [savingName, setSavingName] = useState(false);

  async function handleRotateToken() {
    try {
      const { relay: updated } = await apiFetch<{ relay: RelaySummary }>(
        `/api/relays/${relay.id}/rotate-token`,
        { method: 'POST' },
      );
      setRelay((current) => ({ ...current, ingestToken: updated.ingestToken }));
      toast.success('Ingest URL rotated');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not rotate the token');
    }
  }

  async function handleRenameSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSavingName(true);
    try {
      await apiFetch(`/api/relays/${relay.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      setRelay((current) => ({ ...current, name }));
      toast.success('Saved');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not rename the relay');
    } finally {
      setSavingName(false);
    }
  }

  const Form = RELAY_FORMS[relay.type];

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">{relay.name}</h1>
        <Button variant="ghost" size="sm" onClick={() => router.push('/dashboard')}>
          Back to dashboard
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Name & type</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex items-end gap-2" onSubmit={(e) => void handleRenameSubmit(e)}>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="name">Relay name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <p className="pb-2 text-sm text-[var(--muted)]">{RELAY_TYPE_LABELS[relay.type]}</p>
            <Button type="submit" variant="secondary" size="sm" disabled={savingName}>
              Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trigger</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {relay.type === 'email_api' ? (
            <div className="flex flex-col gap-1.5">
              <Label>Send emails to</Label>
              <CopyField value={relay.emailAddress ?? '—'} />
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label>Ingest URL</Label>
              <CopyField value={`${window.location.origin}/i/${relay.ingestToken}`} />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => void handleRotateToken()}
              >
                Regenerate URL
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Destination</CardTitle>
        </CardHeader>
        <CardContent>
          <Form
            relayId={relay.id}
            configPublic={relay.configPublic}
            hasSecret={relay.hasSecret}
            onSaved={() => router.refresh()}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Send Test Payload</CardTitle>
        </CardHeader>
        <CardContent>
          <TestPayloadPanel
            relayId={relay.id}
            relayType={relay.type}
            samplePayload={SAMPLE_PAYLOADS[relay.type]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
