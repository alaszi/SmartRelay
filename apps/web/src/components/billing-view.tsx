'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api-client';
import { ApiError } from '@/lib/api-shared';
import { relativeTime } from '@/lib/format';

interface Topup {
  id: string;
  amount: string;
  status: string;
  createdAt: string;
}

const PRESET_AMOUNTS = [5, 10, 25];

export function BillingView({ balance, topups }: { balance: string; topups: Topup[] }) {
  const [customAmount, setCustomAmount] = useState('');
  const [loadingAmount, setLoadingAmount] = useState<number | null>(null);

  async function startCheckout(amountEur: number) {
    setLoadingAmount(amountEur);
    try {
      const { url } = await apiFetch<{ url: string | null }>('/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ amountEur }),
      });
      if (url) window.location.href = url;
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not start checkout');
    } finally {
      setLoadingAmount(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Balance: €{balance}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {PRESET_AMOUNTS.map((amount) => (
              <Button
                key={amount}
                variant="secondary"
                onClick={() => void startCheckout(amount)}
                disabled={loadingAmount !== null}
              >
                {loadingAmount === amount ? 'Redirecting…' : `+ €${amount}`}
              </Button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="customAmount" className="text-sm font-medium text-gray-900">
                Custom amount (min €5, max €100)
              </label>
              <Input
                id="customAmount"
                type="number"
                min={5}
                max={100}
                value={customAmount}
                onChange={(e) => setCustomAmount(e.target.value)}
                className="w-32"
              />
            </div>
            <Button
              variant="secondary"
              disabled={loadingAmount !== null || !customAmount}
              onClick={() => void startCheckout(Number(customAmount))}
            >
              Top up
            </Button>
          </div>
          <p className="text-xs text-[var(--muted)]">
            Card processing fees make very small top-ups less efficient — larger, less frequent
            top-ups get you more value per transaction.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          {topups.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No top-ups yet.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {topups.map((topup) => (
                <li
                  key={topup.id}
                  className="flex items-center justify-between border-b border-[var(--border)] pb-2 last:border-0"
                >
                  <span className="text-gray-600">{relativeTime(topup.createdAt)}</span>
                  <span className="text-gray-900">€{topup.amount}</span>
                  <span className="text-xs uppercase text-[var(--muted)]">{topup.status}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
