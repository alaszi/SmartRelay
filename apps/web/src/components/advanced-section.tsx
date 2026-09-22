'use client';

import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Collapsed by default, never in the main flow (MASTER_PLAN section 10). */
export function AdvancedSection({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className="border-t border-[var(--border)] pt-4"
    >
      <Collapsible.Trigger className="flex items-center gap-1.5 text-sm font-medium text-gray-700 hover:text-gray-900">
        <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
        {label}
      </Collapsible.Trigger>
      <Collapsible.Content className="mt-4 flex flex-col gap-4">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
