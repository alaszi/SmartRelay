'use client';

import { useState } from 'react';
import { AdvancedSection } from '@/components/advanced-section';
import { InfoTip } from '@/components/info-tip';
import { JsonPathInput } from '@/components/json-path-input';
import { SecretInput } from '@/components/secret-input';
import { TemplateInput } from '@/components/template-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SAMPLE_PAYLOADS } from '@/lib/sample-payloads';
import { saveRelayConfig, type RelayFormProps } from './shared';

type Provider = 'smslink' | 'twilio' | 'infobip';

const HMAC_PRESETS = {
  none: undefined,
  woocommerce: { header: 'x-wc-webhook-signature', algorithm: 'sha256', encoding: 'base64' },
  shopify: { header: 'x-shopify-hmac-sha256', algorithm: 'sha256', encoding: 'base64' },
} as const;

export function WebhookSmsForm({ relayId, configPublic, hasSecret, onSaved }: RelayFormProps) {
  const [provider, setProvider] = useState<Provider>(
    (configPublic['provider'] as Provider | undefined) ?? 'smslink',
  );
  const [connectionId, setConnectionId] = useState((configPublic['connectionId'] as string) ?? '');
  const [accountSid, setAccountSid] = useState((configPublic['accountSid'] as string) ?? '');
  const [from, setFrom] = useState((configPublic['from'] as string) ?? '');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState((configPublic['baseUrl'] as string) ?? '');
  const [secret, setSecret] = useState('');
  const [recipientPath, setRecipientPath] = useState(
    (configPublic['recipientPath'] as string) ?? '$.customer.phone',
  );
  const [template, setTemplate] = useState((configPublic['template'] as string) ?? '');
  const [hmacPreset, setHmacPreset] = useState<keyof typeof HMAC_PRESETS>('none');
  const [hmacSecret, setHmacSecret] = useState('');
  const [saving, setSaving] = useState(false);

  const samplePayload = SAMPLE_PAYLOADS.webhook_sms;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    const base: Record<string, unknown> = { provider, recipientPath, template };
    if (provider === 'smslink') base['connectionId'] = connectionId;
    if (provider === 'twilio') {
      base['accountSid'] = accountSid;
      base['from'] = from;
    }
    if (provider === 'infobip') base['baseUrl'] = baseUrl;
    const hmac = HMAC_PRESETS[hmacPreset];
    if (hmac) base['hmac'] = hmac;

    const secretField =
      provider === 'smslink' ? 'password' : provider === 'twilio' ? 'authToken' : 'apiKey';
    const secretValue = provider === 'infobip' ? apiKey : secret;

    const secretPatch: Record<string, unknown> = {};
    if (secretValue) secretPatch[secretField] = secretValue;
    if (hmacSecret) secretPatch['hmacSecret'] = hmacSecret;

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
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="provider">SMS provider</Label>
        <select
          id="provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as Provider)}
          className="h-10 rounded-md border border-[var(--border)] bg-white px-3 text-sm"
        >
          <option value="smslink">SMSLink</option>
          <option value="twilio">Twilio</option>
          <option value="infobip">Infobip (coming soon)</option>
        </select>
      </div>

      {provider === 'smslink' && (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <Label htmlFor="connectionId">Connection ID</Label>
              <InfoTip title="Your SMSLink connection identifier." example="12345" />
            </div>
            <Input
              id="connectionId"
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <SecretInput
              id="password"
              value={secret}
              onChange={setSecret}
              hasExistingValue={hasSecret}
            />
          </div>
        </>
      )}

      {provider === 'twilio' && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="accountSid">Account SID</Label>
            <Input
              id="accountSid"
              value={accountSid}
              onChange={(e) => setAccountSid(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="authToken">Auth token</Label>
            <SecretInput
              id="authToken"
              value={secret}
              onChange={setSecret}
              hasExistingValue={hasSecret}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <Label htmlFor="from">Sender number</Label>
              <InfoTip title="Your Twilio sender number, in E.164 format." example="+15551234567" />
            </div>
            <Input id="from" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
        </>
      )}

      {provider === 'infobip' && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="baseUrl">Base URL</Label>
            <Input id="baseUrl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="apiKey">API key</Label>
            <SecretInput
              id="apiKey"
              value={apiKey}
              onChange={setApiKey}
              hasExistingValue={hasSecret}
            />
          </div>
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <Label htmlFor="recipientPath">Recipient phone (JSONPath)</Label>
          <InfoTip
            title="Where in the incoming payload to find the recipient's phone number."
            example="$.customer.phone"
          />
        </div>
        <JsonPathInput
          id="recipientPath"
          value={recipientPath}
          onChange={setRecipientPath}
          samplePayload={samplePayload}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <Label htmlFor="template">Message</Label>
          <InfoTip
            title="The SMS text. Use {{$.path}} to insert values from the incoming payload."
            example="Hi {{$.customer.name}}, your order shipped!"
          />
        </div>
        <TemplateInput
          id="template"
          value={template}
          onChange={setTemplate}
          samplePayload={samplePayload}
        />
      </div>

      <AdvancedSection label="Advanced: webhook signature (HMAC)">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hmacPreset">Verify the sender</Label>
          <select
            id="hmacPreset"
            value={hmacPreset}
            onChange={(e) => setHmacPreset(e.target.value as keyof typeof HMAC_PRESETS)}
            className="h-10 rounded-md border border-[var(--border)] bg-white px-3 text-sm"
          >
            <option value="none">None</option>
            <option value="woocommerce">WooCommerce</option>
            <option value="shopify">Shopify</option>
          </select>
        </div>
        {hmacPreset !== 'none' && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <Label htmlFor="hmacSecret">Webhook signing secret</Label>
              <InfoTip title="From your store's webhook settings; used to verify each request's signature." />
            </div>
            <SecretInput
              id="hmacSecret"
              value={hmacSecret}
              onChange={setHmacSecret}
              hasExistingValue={hasSecret}
            />
          </div>
        )}
      </AdvancedSection>

      <Button type="submit" disabled={saving} className="self-start">
        {saving ? 'Saving…' : 'Save destination'}
      </Button>
    </form>
  );
}
