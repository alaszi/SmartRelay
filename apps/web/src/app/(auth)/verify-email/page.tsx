'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AuthCard } from '@/components/auth-card';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { ApiError } from '@/lib/api-shared';

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}

function VerifyEmail() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState<'pending' | 'success' | 'error'>('pending');
  const [message, setMessage] = useState('');
  // The verify token is single-use, so the request itself must fire at most once — React 19's
  // StrictMode double-invokes effects in dev, and a second call would see "already consumed" and
  // overwrite a genuine success with a false error.
  const requested = useRef(false);

  useEffect(() => {
    if (!token) {
      setState('error');
      setMessage('This verification link is missing its token.');
      return;
    }
    if (requested.current) return;
    requested.current = true;
    apiFetch('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) })
      .then(() => setState('success'))
      .catch((error: unknown) => {
        setState('error');
        setMessage(error instanceof ApiError ? error.message : 'Could not verify this email.');
      });
  }, [token]);

  return (
    <AuthCard title="Verify your email">
      {state === 'pending' ? <p className="text-sm text-[var(--muted)]">Verifying…</p> : null}
      {state === 'success' ? (
        <>
          <p className="text-sm text-gray-700">
            Your email is verified. You can now create relays.
          </p>
          <Button asChild>
            <Link href="/dashboard">Go to dashboard</Link>
          </Button>
        </>
      ) : null}
      {state === 'error' ? <p className="text-sm text-red-600">{message}</p> : null}
    </AuthCard>
  );
}
