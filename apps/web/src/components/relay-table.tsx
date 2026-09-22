'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { ApiError } from '@/lib/api-shared';
import { relativeTime } from '@/lib/format';
import { RELAY_TYPE_LABELS, type RelaySummary } from '@/lib/relay-types';

export function RelayTable({ relays: initialRelays }: { relays: RelaySummary[] }) {
  const [relays, setRelays] = useState(initialRelays);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const router = useRouter();

  async function toggleStatus(relay: RelaySummary) {
    const nextStatus = relay.status === 'active' ? 'inactive' : 'active';
    setPendingId(relay.id);
    try {
      await apiFetch(`/api/relays/${relay.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      setRelays((current) =>
        current.map((r) => (r.id === relay.id ? { ...r, status: nextStatus } : r)),
      );
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not update the relay');
    } finally {
      setPendingId(null);
    }
  }

  async function handleDelete(relay: RelaySummary) {
    if (!window.confirm(`Delete "${relay.name}"? This cannot be undone.`)) return;
    setPendingId(relay.id);
    try {
      await apiFetch(`/api/relays/${relay.id}`, { method: 'DELETE' });
      setRelays((current) => current.filter((r) => r.id !== relay.id));
      toast.success('Relay deleted');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not delete the relay');
    } finally {
      setPendingId(null);
      router.refresh();
    }
  }

  if (relays.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-[var(--border)] bg-white py-16 text-center">
        <p className="text-sm text-[var(--muted)]">
          You have no relays yet. Create one to start relaying events.
        </p>
        <Button asChild>
          <Link href="/relays/new">+ New Relay</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-white">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-[var(--border)] bg-gray-50 text-xs uppercase text-[var(--muted)]">
          <tr>
            <th className="px-4 py-3 font-medium">Name</th>
            <th className="px-4 py-3 font-medium">Type</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Last triggered</th>
            <th className="px-4 py-3 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {relays.map((relay) => (
            <tr key={relay.id} className="border-b border-[var(--border)] last:border-0">
              <td className="px-4 py-3">
                <Link
                  href={`/relays/${relay.id}`}
                  className="font-medium text-gray-900 hover:underline"
                >
                  {relay.name}
                </Link>
              </td>
              <td className="px-4 py-3 text-gray-600">{RELAY_TYPE_LABELS[relay.type]}</td>
              <td className="px-4 py-3">
                <button
                  type="button"
                  disabled={pendingId === relay.id}
                  onClick={() => void toggleStatus(relay)}
                  className={
                    relay.status === 'active'
                      ? 'rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700'
                      : 'rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600'
                  }
                >
                  {relay.status === 'active' ? 'Active' : 'Inactive'}
                </button>
              </td>
              <td className="px-4 py-3 text-gray-600">{relativeTime(relay.lastTriggeredAt)}</td>
              <td className="px-4 py-3">
                <div className="flex gap-2">
                  <Button asChild variant="secondary" size="sm">
                    <Link href={`/relays/${relay.id}`}>Edit</Link>
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={pendingId === relay.id}
                    onClick={() => void handleDelete(relay)}
                  >
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
