'use client';

import { useEffect, useState } from 'react';
import { AdvancedSection } from '@/components/advanced-section';
import { InfoTip } from '@/components/info-tip';
import { JsonPathInput } from '@/components/json-path-input';
import { SecretInput } from '@/components/secret-input';
import { TemplateInput } from '@/components/template-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api-client';
import { SAMPLE_PAYLOADS } from '@/lib/sample-payloads';
import { GoogleConnectionField } from './google-connection-field';
import { saveRelayConfig, type RelayFormProps } from './shared';

type ReminderProvider = 'smslink' | 'twilio' | 'infobip';

export function CalendarBridgeForm({ relayId, configPublic, hasSecret, onSaved }: RelayFormProps) {
  const [titleTemplate, setTitleTemplate] = useState(
    (configPublic['titleTemplate'] as string) ?? '',
  );
  const [startPath, setStartPath] = useState(
    (configPublic['startPath'] as string) ?? '$.booking.start',
  );
  const [endPath, setEndPath] = useState((configPublic['endPath'] as string) ?? '$.booking.end');

  const storedMode = configPublic['reminderMode'] as ReminderProvider | 'off' | undefined;
  const [reminderEnabled, setReminderEnabled] = useState(
    storedMode !== undefined && storedMode !== 'off',
  );
  const [reminderProvider, setReminderProvider] = useState<ReminderProvider>(
    storedMode && storedMode !== 'off' ? storedMode : 'smslink',
  );
  const [reminderOffsetMinutes, setReminderOffsetMinutes] = useState(
    String((configPublic['reminderOffsetMinutes'] as number | undefined) ?? 120),
  );
  const [reminderRecipientPath, setReminderRecipientPath] = useState(
    (configPublic['reminderRecipientPath'] as string) ?? '$.customer.phone',
  );
  const [reminderTemplate, setReminderTemplate] = useState(
    (configPublic['reminderTemplate'] as string) ?? '',
  );
  const [reminderConnectionId, setReminderConnectionId] = useState(
    (configPublic['reminderConnectionId'] as string) ?? '',
  );
  const [reminderAccountSid, setReminderAccountSid] = useState(
    (configPublic['reminderAccountSid'] as string) ?? '',
  );
  const [reminderFrom, setReminderFrom] = useState((configPublic['reminderFrom'] as string) ?? '');
  const [reminderBaseUrl, setReminderBaseUrl] = useState(
    (configPublic['reminderBaseUrl'] as string) ?? '',
  );
  const [reminderSecret, setReminderSecret] = useState('');
  const [saving, setSaving] = useState(false);

  const samplePayload = SAMPLE_PAYLOADS.calendar_bridge;

  // MASTER_PLAN section 6: "prefill from the user's existing SMS relay if any" — a convenience
  // only, so it only ever fills currently-empty fields and never overwrites what's already saved
  // for this relay's reminder. The secret itself can never be prefilled (write-only, section 8.1);
  // the user still has to re-enter it once.
  useEffect(() => {
    if (storedMode !== undefined) return; // already configured on this relay — don't override it
    apiFetch<{ relays: Array<{ type: string; configPublic: Record<string, unknown> }> }>(
      '/api/relays',
    )
      .then(({ relays }) => {
        const smsRelay = relays.find((r) => r.type === 'webhook_sms');
        if (!smsRelay) return;
        const cfg = smsRelay.configPublic;
        const provider = cfg['provider'] as ReminderProvider | undefined;
        if (!provider) return;
        setReminderProvider(provider);
        if (provider === 'smslink') setReminderConnectionId((cfg['connectionId'] as string) ?? '');
        if (provider === 'twilio') {
          setReminderAccountSid((cfg['accountSid'] as string) ?? '');
          setReminderFrom((cfg['from'] as string) ?? '');
        }
        if (provider === 'infobip') setReminderBaseUrl((cfg['baseUrl'] as string) ?? '');
      })
      .catch(() => undefined);
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);

    const base: Record<string, unknown> = { titleTemplate, startPath, endPath };
    if (reminderEnabled) {
      base['reminderMode'] = reminderProvider;
      base['reminderOffsetMinutes'] = Number(reminderOffsetMinutes);
      base['reminderRecipientPath'] = reminderRecipientPath;
      base['reminderTemplate'] = reminderTemplate;
      if (reminderProvider === 'smslink') base['reminderConnectionId'] = reminderConnectionId;
      if (reminderProvider === 'twilio') {
        base['reminderAccountSid'] = reminderAccountSid;
        base['reminderFrom'] = reminderFrom;
      }
      if (reminderProvider === 'infobip') base['reminderBaseUrl'] = reminderBaseUrl;
    } else {
      base['reminderMode'] = 'off';
    }

    const secretPatch: Record<string, unknown> = {};
    if (reminderEnabled && reminderSecret) secretPatch['reminderSecret'] = reminderSecret;

    // The Google connection saves itself immediately when connected or picked (see
    // GoogleConnectionField) — it isn't part of this submit, since attaching it needs a server
    // round-trip (the refresh token is never sent to the browser to bundle into this PATCH).
    const ok = await saveRelayConfig(
      relayId,
      base,
      Object.keys(secretPatch).length > 0 ? secretPatch : undefined,
    );
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

      <AdvancedSection label="Advanced: SMS reminder">
        <div className="flex items-center gap-2">
          <input
            id="reminderEnabled"
            type="checkbox"
            checked={reminderEnabled}
            onChange={(e) => setReminderEnabled(e.target.checked)}
            className="h-4 w-4"
          />
          <Label htmlFor="reminderEnabled">Send an SMS reminder before the event</Label>
        </div>

        {reminderEnabled && (
          <>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1">
                <Label htmlFor="reminderOffsetMinutes">Send how many minutes before</Label>
                <InfoTip
                  title="How long before the event start to send the reminder."
                  example="120 = 2 hours before"
                />
              </div>
              <Input
                id="reminderOffsetMinutes"
                type="number"
                min={1}
                max={7 * 24 * 60}
                value={reminderOffsetMinutes}
                onChange={(e) => setReminderOffsetMinutes(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1">
                <Label htmlFor="reminderRecipientPath">Recipient phone (JSONPath)</Label>
                <InfoTip
                  title="Where in the incoming payload to find the recipient's phone number."
                  example="$.customer.phone"
                />
              </div>
              <JsonPathInput
                id="reminderRecipientPath"
                value={reminderRecipientPath}
                onChange={setReminderRecipientPath}
                samplePayload={samplePayload}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1">
                <Label htmlFor="reminderTemplate">Reminder message</Label>
                <InfoTip
                  title="The SMS text. Use {{$.path}} to insert values from the incoming payload."
                  example="Hi {{$.customer.name}}, reminder: your appointment is coming up soon!"
                />
              </div>
              <TemplateInput
                id="reminderTemplate"
                value={reminderTemplate}
                onChange={setReminderTemplate}
                samplePayload={samplePayload}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reminderProvider">SMS provider</Label>
              <select
                id="reminderProvider"
                value={reminderProvider}
                onChange={(e) => setReminderProvider(e.target.value as ReminderProvider)}
                className="h-10 rounded-md border border-[var(--border)] bg-white px-3 text-sm"
              >
                <option value="smslink">SMSLink</option>
                <option value="twilio">Twilio</option>
                <option value="infobip">Infobip (coming soon)</option>
              </select>
            </div>

            {reminderProvider === 'smslink' && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reminderConnectionId">Connection ID</Label>
                  <Input
                    id="reminderConnectionId"
                    value={reminderConnectionId}
                    onChange={(e) => setReminderConnectionId(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reminderSecretSmsLink">Password</Label>
                  <SecretInput
                    id="reminderSecretSmsLink"
                    value={reminderSecret}
                    onChange={setReminderSecret}
                    hasExistingValue={hasSecret}
                  />
                </div>
              </>
            )}

            {reminderProvider === 'twilio' && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reminderAccountSid">Account SID</Label>
                  <Input
                    id="reminderAccountSid"
                    value={reminderAccountSid}
                    onChange={(e) => setReminderAccountSid(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reminderSecretTwilio">Auth token</Label>
                  <SecretInput
                    id="reminderSecretTwilio"
                    value={reminderSecret}
                    onChange={setReminderSecret}
                    hasExistingValue={hasSecret}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1">
                    <Label htmlFor="reminderFrom">Sender number</Label>
                    <InfoTip
                      title="Your Twilio sender number, in E.164 format."
                      example="+15551234567"
                    />
                  </div>
                  <Input
                    id="reminderFrom"
                    value={reminderFrom}
                    onChange={(e) => setReminderFrom(e.target.value)}
                  />
                </div>
              </>
            )}

            {reminderProvider === 'infobip' && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reminderBaseUrl">Base URL</Label>
                  <Input
                    id="reminderBaseUrl"
                    value={reminderBaseUrl}
                    onChange={(e) => setReminderBaseUrl(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reminderSecretInfobip">API key</Label>
                  <SecretInput
                    id="reminderSecretInfobip"
                    value={reminderSecret}
                    onChange={setReminderSecret}
                    hasExistingValue={hasSecret}
                  />
                </div>
              </>
            )}
          </>
        )}
      </AdvancedSection>

      <Button type="submit" disabled={saving} className="self-start">
        {saving ? 'Saving…' : 'Save destination'}
      </Button>
    </form>
  );
}
