'use client';

import { useState } from 'react';
import { InfoTip } from '@/components/info-tip';
import { SecretInput } from '@/components/secret-input';
import { TemplateInput } from '@/components/template-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SAMPLE_PAYLOADS } from '@/lib/sample-payloads';
import { saveRelayConfig, type RelayFormProps } from './shared';

type Platform = 'telegram' | 'discord';

export function ChatRelayForm({ relayId, configPublic, hasSecret, onSaved }: RelayFormProps) {
  const [platform, setPlatform] = useState<Platform>(
    (configPublic['platform'] as Platform | undefined) ?? 'telegram',
  );
  const [chatId, setChatId] = useState((configPublic['chatId'] as string) ?? '');
  const [webhookUrl, setWebhookUrl] = useState((configPublic['webhookUrl'] as string) ?? '');
  const [botToken, setBotToken] = useState('');
  const [template, setTemplate] = useState((configPublic['template'] as string) ?? '');
  const [saving, setSaving] = useState(false);

  const samplePayload = SAMPLE_PAYLOADS.chat_relay;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    const base: Record<string, unknown> =
      platform === 'telegram' ? { platform, chatId, template } : { platform, webhookUrl, template };
    const ok = await saveRelayConfig(
      relayId,
      base,
      platform === 'telegram' && botToken ? { botToken } : undefined,
    );
    setSaving(false);
    if (ok) onSaved();
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void handleSubmit(e)}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="platform">Platform</Label>
        <select
          id="platform"
          value={platform}
          onChange={(e) => setPlatform(e.target.value as Platform)}
          className="h-10 rounded-md border border-[var(--border)] bg-white px-3 text-sm"
        >
          <option value="telegram">Telegram</option>
          <option value="discord">Discord</option>
        </select>
      </div>

      {platform === 'telegram' ? (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <Label htmlFor="botToken">Bot token</Label>
              <InfoTip
                title="From @BotFather. Verified with getMe when you save."
                example="123456:ABC-DEF..."
              />
            </div>
            <SecretInput
              id="botToken"
              value={botToken}
              onChange={setBotToken}
              hasExistingValue={hasSecret}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <Label htmlFor="chatId">Chat ID</Label>
              <InfoTip title="The chat or channel to post to." example="-1001234567890" />
            </div>
            <Input id="chatId" value={chatId} onChange={(e) => setChatId(e.target.value)} />
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1">
            <Label htmlFor="webhookUrl">Discord webhook URL</Label>
            <InfoTip
              title="Channel Settings → Integrations → Webhooks → Copy Webhook URL."
              example="https://discord.com/api/webhooks/123/token"
            />
          </div>
          <Input
            id="webhookUrl"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
          />
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <Label htmlFor="template">Message</Label>
          <InfoTip
            title="Use {{$.path}} to insert values from the incoming payload."
            example="Order #{{$.order.id}} from {{$.customer.name}}"
          />
        </div>
        <TemplateInput
          id="template"
          value={template}
          onChange={setTemplate}
          samplePayload={samplePayload}
        />
      </div>

      <Button type="submit" disabled={saving} className="self-start">
        {saving ? 'Saving…' : 'Save destination'}
      </Button>
    </form>
  );
}
