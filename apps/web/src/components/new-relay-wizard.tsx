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
import { RELAY_TYPE_DESCRIPTIONS, RELAY_TYPE_LABELS, type RelaySummary } from '@/lib/relay-types';
import { SAMPLE_PAYLOADS } from '@/lib/sample-payloads';
import type { RelayType } from '@smartrelay/shared';

const STEPS = ['Name & type', 'Trigger', 'Destination', 'Test'] as const;
const RELAY_TYPES = Object.keys(RELAY_TYPE_LABELS) as RelayType[];

export function NewRelayWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [type, setType] = useState<RelayType>('webhook_sms');
  const [creating, setCreating] = useState(false);
  const [relay, setRelay] = useState<(RelaySummary & { emailAddress?: string }) | null>(null);

  async function handleCreate() {
    if (!name.trim()) {
      toast.error('Give the relay a name');
      return;
    }
    setCreating(true);
    try {
      const { relay: created } = await apiFetch<{
        relay: RelaySummary & { emailAddress?: string };
      }>('/api/relays', { method: 'POST', body: JSON.stringify({ name, type }) });
      setRelay(created);
      setStep(1);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not create the relay');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <ol className="flex items-center gap-2 text-xs font-medium text-[var(--muted)]">
        {STEPS.map((label, index) => (
          <li key={label} className={index === step ? 'text-accent-700' : undefined}>
            {index + 1}. {label}
            {index < STEPS.length - 1 ? <span className="mx-2 text-gray-300">→</span> : null}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Name & type</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name">Relay name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Order notifications"
              />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {RELAY_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={`rounded-lg border p-3 text-left text-sm ${
                    type === t
                      ? 'border-accent-500 bg-accent-50'
                      : 'border-[var(--border)] hover:border-gray-300'
                  }`}
                >
                  <p className="font-medium text-gray-900">{RELAY_TYPE_LABELS[t]}</p>
                  <p className="text-xs text-[var(--muted)]">{RELAY_TYPE_DESCRIPTIONS[t]}</p>
                </button>
              ))}
            </div>
            <Button onClick={() => void handleCreate()} disabled={creating} className="self-end">
              {creating ? 'Creating…' : 'Next'}
            </Button>
          </CardContent>
        </Card>
      )}

      {step === 1 && relay && (
        <Card>
          <CardHeader>
            <CardTitle>Trigger</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {relay.type === 'email_api' ? (
              <div className="flex flex-col gap-1.5">
                <Label>Send emails to</Label>
                <CopyField value={relay.emailAddress ?? 'Generating…'} />
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label>Ingest URL</Label>
                <CopyField value={`${window.location.origin}/i/${relay.ingestToken}`} />
              </div>
            )}
            <Button onClick={() => setStep(2)} className="self-end">
              Next
            </Button>
          </CardContent>
        </Card>
      )}

      {step === 2 && relay && (
        <Card>
          <CardHeader>
            <CardTitle>Destination</CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              const Form = RELAY_FORMS[relay.type];
              return (
                <Form
                  relayId={relay.id}
                  configPublic={relay.configPublic}
                  hasSecret={relay.hasSecret}
                  onSaved={() => setStep(3)}
                />
              );
            })()}
          </CardContent>
        </Card>
      )}

      {step === 3 && relay && (
        <Card>
          <CardHeader>
            <CardTitle>Send Test Payload</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <TestPayloadPanel
              relayId={relay.id}
              relayType={relay.type}
              samplePayload={SAMPLE_PAYLOADS[relay.type]}
            />
            <Button
              variant="secondary"
              onClick={() => router.push('/dashboard')}
              className="self-end"
            >
              Done — go to dashboard
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
