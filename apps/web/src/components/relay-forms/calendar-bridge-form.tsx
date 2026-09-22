'use client';

import { useState } from 'react';
import { InfoTip } from '@/components/info-tip';
import { JsonPathInput } from '@/components/json-path-input';
import { SecretInput } from '@/components/secret-input';
import { TemplateInput } from '@/components/template-input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SAMPLE_PAYLOADS } from '@/lib/sample-payloads';
import { saveRelayConfig, type RelayFormProps } from './shared';

export function CalendarBridgeForm({ relayId, configPublic, hasSecret, onSaved }: RelayFormProps) {
  const [titleTemplate, setTitleTemplate] = useState(
    (configPublic['titleTemplate'] as string) ?? '',
  );
  const [startPath, setStartPath] = useState(
    (configPublic['startPath'] as string) ?? '$.booking.start',
  );
  const [endPath, setEndPath] = useState((configPublic['endPath'] as string) ?? '$.booking.end');
  const [refreshToken, setRefreshToken] = useState('');
  const [saving, setSaving] = useState(false);

  const samplePayload = SAMPLE_PAYLOADS.calendar_bridge;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    const ok = await saveRelayConfig(
      relayId,
      { titleTemplate, startPath, endPath },
      refreshToken ? { refreshToken } : undefined,
    );
    setSaving(false);
    if (ok) onSaved();
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void handleSubmit(e)}>
      <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
        The one-click "Connect Google" flow ships in a later update. For now, paste a Google OAuth
        refresh token with the <code className="font-mono">calendar.events</code> scope.
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <Label htmlFor="refreshToken">Google refresh token</Label>
          <InfoTip title="Encrypted at rest; never shown again after saving." />
        </div>
        <SecretInput
          id="refreshToken"
          value={refreshToken}
          onChange={setRefreshToken}
          hasExistingValue={hasSecret}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <Label htmlFor="titleTemplate">Event title</Label>
          <InfoTip
            title="Use {{$.path}} to insert values from the incoming payload."
            example="Booking: {{$.customer.name}}"
          />
        </div>
        <TemplateInput
          id="titleTemplate"
          value={titleTemplate}
          onChange={setTitleTemplate}
          samplePayload={samplePayload}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <Label htmlFor="startPath">Start time (JSONPath)</Label>
          <InfoTip
            title="ISO 8601. With a UTC offset it's used as-is; without one it's read in your account timezone."
            example="$.booking.start"
          />
        </div>
        <JsonPathInput
          id="startPath"
          value={startPath}
          onChange={setStartPath}
          samplePayload={samplePayload}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="endPath">End time (JSONPath)</Label>
        <JsonPathInput
          id="endPath"
          value={endPath}
          onChange={setEndPath}
          samplePayload={samplePayload}
        />
      </div>

      <Button type="submit" disabled={saving} className="self-start">
        {saving ? 'Saving…' : 'Save destination'}
      </Button>
    </form>
  );
}
