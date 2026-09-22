'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Write-only secret field (MASTER_PLAN section 8.1): the API never returns a stored secret, so an
 * existing one renders as a masked placeholder with a "Replace" action. Nothing is sent to the API
 * unless the user actually types a new value.
 */
export function SecretInput({
  value,
  onChange,
  hasExistingValue,
  placeholder,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  hasExistingValue: boolean;
  placeholder?: string;
  id?: string;
}) {
  const [replacing, setReplacing] = useState(!hasExistingValue);

  if (!replacing) {
    return (
      <div className="flex items-center gap-2">
        <Input id={id} value="••••••••••••" disabled readOnly />
        <Button type="button" variant="secondary" size="sm" onClick={() => setReplacing(true)}>
          Replace
        </Button>
      </div>
    );
  }

  return (
    <Input
      id={id}
      type="password"
      autoComplete="off"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
