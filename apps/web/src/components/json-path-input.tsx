'use client';

import { JsonPathError, queryFirst, validateJsonPath } from '@smartrelay/engine/browser';
import { useMemo } from 'react';
import { Input } from '@/components/ui/input';

/** Validates JSONPath syntax and shows a live preview against the sample payload (MASTER_PLAN
 * section 10). */
export function JsonPathInput({
  value,
  onChange,
  samplePayload,
  id,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  samplePayload: unknown;
  id?: string;
  placeholder?: string;
}) {
  const preview = useMemo(() => {
    if (value.trim().length === 0) return null;
    try {
      validateJsonPath(value);
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof JsonPathError ? error.message : 'Invalid JSONPath',
      };
    }
    const result = queryFirst(samplePayload, value);
    return result.found
      ? { ok: true as const, value: JSON.stringify(result.value) }
      : { ok: true as const, value: null };
  }, [value, samplePayload]);

  return (
    <div className="flex flex-col gap-1">
      <Input
        id={id}
        value={value}
        placeholder={placeholder ?? '$.customer.phone'}
        className="font-mono text-sm"
        onChange={(event) => onChange(event.target.value)}
      />
      {preview && !preview.ok ? <p className="text-sm text-red-600">{preview.message}</p> : null}
      {preview?.ok && preview.value !== null ? (
        <p className="text-xs text-[var(--muted)]">
          Preview: <span className="font-mono text-gray-700">{preview.value}</span>
        </p>
      ) : null}
      {preview?.ok && preview.value === null ? (
        <p className="text-xs text-amber-600">No match in the sample payload.</p>
      ) : null}
    </div>
  );
}
