'use client';

import { useState } from 'react';
import { AdvancedSection } from '@/components/advanced-section';
import { InfoTip } from '@/components/info-tip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { saveRelayConfig, type RelayFormProps } from './shared';

interface ParsingRule {
  name: string;
  type: 'jsonpath' | 'regex';
  expression: string;
}

export function EmailApiForm({ relayId, configPublic, onSaved }: RelayFormProps) {
  const [targetUrl, setTargetUrl] = useState((configPublic['targetUrl'] as string) ?? '');
  const [rules, setRules] = useState<ParsingRule[]>(
    (configPublic['parsingRules'] as ParsingRule[] | undefined) ?? [],
  );
  const [subjectContains, setSubjectContains] = useState(
    (configPublic['filter'] as { subjectContains?: string } | undefined)?.subjectContains ?? '',
  );
  const [saving, setSaving] = useState(false);

  function addRule() {
    setRules((current) => [...current, { name: '', type: 'jsonpath', expression: '' }]);
  }
  function updateRule(index: number, patch: Partial<ParsingRule>) {
    setRules((current) => current.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function removeRule(index: number) {
    setRules((current) => current.filter((_, i) => i !== index));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    const configPublicNext: Record<string, unknown> = {
      targetUrl,
      parsingRules: rules.filter((r) => r.name && r.expression),
    };
    if (subjectContains) configPublicNext['filter'] = { subjectContains };
    const ok = await saveRelayConfig(relayId, configPublicNext, undefined);
    setSaving(false);
    if (ok) onSaved();
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void handleSubmit(e)}>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <Label htmlFor="targetUrl">Target webhook URL</Label>
          <InfoTip
            title="Where the parsed email is POSTed as JSON."
            example="https://api.example.com/orders"
          />
        </div>
        <Input id="targetUrl" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} />
      </div>

      <AdvancedSection label="Advanced: parsing rules & filter">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="subjectContains">Only process emails whose subject contains</Label>
          <Input
            id="subjectContains"
            value={subjectContains}
            onChange={(e) => setSubjectContains(e.target.value)}
            placeholder="Order"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Parsing rules</Label>
          {rules.map((rule, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                value={rule.name}
                onChange={(e) => updateRule(index, { name: e.target.value })}
                placeholder="orderId"
                className="w-28"
              />
              <select
                value={rule.type}
                onChange={(e) => updateRule(index, { type: e.target.value as ParsingRule['type'] })}
                className="h-10 rounded-md border border-[var(--border)] bg-white px-2 text-sm"
              >
                <option value="jsonpath">JSONPath</option>
                <option value="regex">Regex</option>
              </select>
              <Input
                value={rule.expression}
                onChange={(e) => updateRule(index, { expression: e.target.value })}
                placeholder={rule.type === 'jsonpath' ? '$.fields.Order' : '(?<order>\\d+)'}
                className="flex-1 font-mono text-xs"
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => removeRule(index)}>
                Remove
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={addRule}
          >
            + Add rule
          </Button>
        </div>
      </AdvancedSection>

      <Button type="submit" disabled={saving} className="self-start">
        {saving ? 'Saving…' : 'Save destination'}
      </Button>
    </form>
  );
}
