'use client';

import { parseTemplate, renderTemplate, TemplateError } from '@smartrelay/engine/browser';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';

/** Highlights `{{$.path}}` variables and shows the resolved preview against the sample payload
 * (MASTER_PLAN section 10). */
export function TemplateInput({
  value,
  onChange,
  samplePayload,
  id,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (value: string) => void;
  samplePayload: unknown;
  id?: string;
  placeholder?: string;
  rows?: number;
}) {
  const parts = useMemo(() => {
    try {
      return { ok: true as const, parts: parseTemplate(value) };
    } catch {
      return { ok: false as const, parts: [] };
    }
  }, [value]);

  const preview = useMemo(() => {
    if (value.trim().length === 0) return null;
    try {
      return { ok: true as const, text: renderTemplate(value, samplePayload) };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof TemplateError ? error.message : 'Could not render the template',
      };
    }
  }, [value, samplePayload]);

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        id={id}
        value={value}
        placeholder={placeholder ?? 'Hi {{$.customer.name}}, order #{{$.order.id}} shipped!'}
        rows={rows}
        className={cn(
          'flex w-full rounded-md border border-[var(--border)] bg-white px-3 py-2 font-mono text-sm text-gray-900 placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400',
        )}
        onChange={(event) => onChange(event.target.value)}
      />
      {parts.ok && parts.parts.some((part) => part.kind === 'path') ? (
        <p className="flex flex-wrap gap-1 text-xs">
          {parts.parts.map((part, index) =>
            part.kind === 'path' ? (
              <span
                key={index}
                className="rounded bg-accent-50 px-1.5 py-0.5 font-mono text-accent-700"
              >
                {'{{' + part.path + '}}'}
              </span>
            ) : null,
          )}
        </p>
      ) : null}
      {preview && !preview.ok ? <p className="text-sm text-red-600">{preview.message}</p> : null}
      {preview?.ok ? (
        <p className="rounded bg-gray-50 px-2 py-1.5 text-xs text-gray-600">
          Preview: <span className="text-gray-800">{preview.text}</span>
        </p>
      ) : null}
    </div>
  );
}
