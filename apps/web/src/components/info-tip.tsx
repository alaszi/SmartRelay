'use client';

import * as Popover from '@radix-ui/react-popover';
import { Info } from 'lucide-react';

/** `(?)` icon on every non-trivial field (MASTER_PLAN section 10): hover/click popover with a
 * short explanation and a real example. */
export function InfoTip({ title, example }: { title: string; example?: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="More information"
          className="inline-flex size-4 items-center justify-center rounded-full text-[var(--muted)] hover:text-accent-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
        >
          <Info className="size-3.5" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          className="z-50 max-w-xs rounded-md border border-[var(--border)] bg-white p-3 text-sm text-gray-700 shadow-md"
        >
          <p>{title}</p>
          {example ? (
            <p className="mt-1.5 rounded bg-gray-50 px-2 py-1 font-mono text-xs text-gray-600">
              {example}
            </p>
          ) : null}
          <Popover.Arrow className="fill-white" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
