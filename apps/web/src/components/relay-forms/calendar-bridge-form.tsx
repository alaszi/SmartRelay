'use client';

import { useState } from 'react';
import { InfoTip } from '@/components/info-tip';
import { JsonPathInput } from '@/components/json-path-input';
import { TemplateInput } from '@/components/template-input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SAMPLE_PAYLOADS } from '@/lib/sample-payloads';
import { GoogleConnectionField } from './google-connection-field';
import { saveRelayConfig, type RelayFormProps } from './shared';

export function CalendarBridgeForm({ relayId, configPublic, hasSecret, onSaved }: RelayFormProps) {
  const [titleTemplate, setTitleTemplate] = useState(
    (configPublic['titleTemplate'] as string) ?? '',
  );
  const [startPath, setStartPath] = useState(
    (configPublic['startPath'] as string) ?? '$.booking.start',
  );
  const [endPath, setEndPath] = useState((configPublic['endPath'] as string) ?? '$.booking.end');
  const [saving, setSaving] = useState(false);

  const samplePayload = SAMPLE_PAYLOADS.calendar_bridge;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    // The Google connection saves itself immediately when connected or picked (see
    // GoogleConnectionField) — it isn't part of this submit, since attaching it needs a server
    // round-trip (the refresh token is never sent to the browser to bundle into this PATCH).
    const ok = await saveRelayConfig(relayId, { titleTemplate, startPath, endPath }, undefined);
    setSaving(false);
    if (ok) onSaved();
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void handleSubmit(e)}>
      <GoogleConnectionField relayId={relayId} connected={hasSecret} />

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
