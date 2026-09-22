'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export const DialogRoot = DialogPrimitive.Root;

export function DrawerContent({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/30" />
      <DialogPrimitive.Content className="fixed top-0 right-0 z-50 flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <DialogPrimitive.Title className="text-lg font-semibold text-gray-900">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Close asChild>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-gray-500 hover:text-gray-800"
            >
              <X className="size-5" />
            </button>
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
