'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';
import { toast } from 'sonner';

function Notice() {
  const params = useSearchParams();
  const shown = useRef(false);

  useEffect(() => {
    if (shown.current) return;
    shown.current = true;
    const connected = params.get('connected');
    const error = params.get('googleError');
    if (connected) toast.success(`Connected as ${connected}`);
    if (error) toast.error(`Google connection failed: ${error}`);
  }, [params]);

  return null;
}

/** Surfaces the redirect from GET /api/oauth/google/callback (?connected=<email> or
 * ?googleError=<reason>) as a toast, once. Renders nothing itself. */
export function GoogleConnectionNotice() {
  return (
    <Suspense>
      <Notice />
    </Suspense>
  );
}
