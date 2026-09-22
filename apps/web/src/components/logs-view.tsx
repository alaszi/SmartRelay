'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { DialogRoot, DrawerContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { ApiError } from '@/lib/api-shared';
import { relativeTime } from '@/lib/format';

interface LogItem {
  id: string;
  relayId: string;
  relayName: string;
  source: string;
  status: string;
  cost: string;
  errorCode: string | null;
  finalStatusCode: number | null;
  receivedAt: string;
}

interface LogDetail {
  event: LogItem & { finishedAt: string | null };
  payload: { in: unknown; out: unknown; responseExcerpt: string | null } | null;
  attempts: {
    attemptNo: number;
    ok: boolean;
    statusCode: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    durationMs: number | null;
    startedAt: string;
  }[];
}

const STATUS_STYLES: Record<string, string> = {
  SUCCESS: 'bg-green-50 text-green-700',
  FAILED: 'bg-red-50 text-red-700',
  HELD_NO_CREDIT: 'bg-amber-50 text-amber-700',
  DROPPED_LOOP: 'bg-gray-100 text-gray-600',
  REJECTED: 'bg-gray-100 text-gray-600',
  EXPIRED: 'bg-gray-100 text-gray-600',
};

function statusLabel(item: LogItem): string {
  if (item.status === 'SUCCESS') return `SUCCESS ${item.finalStatusCode ?? ''}`.trim();
  if (item.status === 'FAILED')
    return `FAILED ${item.finalStatusCode ?? item.errorCode ?? ''}`.trim();
  if (item.status === 'HELD_NO_CREDIT') return 'HELD';
  return item.status;
}

export function LogsView({
  initialEvents,
  initialCursor,
}: {
  initialEvents: LogItem[];
  initialCursor: string | null;
}) {
  const [events, setEvents] = useState(initialEvents);
  const [cursor, setCursor] = useState(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<LogDetail | null>(null);

  async function applyFilter(status: string) {
    setStatusFilter(status);
    try {
      const query = status ? `?status=${status}` : '';
      const response = await apiFetch<{ events: LogItem[]; nextCursor: string | null }>(
        `/api/logs${query}`,
      );
      setEvents(response.events);
      setCursor(response.nextCursor);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not load logs');
    }
  }

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const query = new URLSearchParams({ cursor });
      if (statusFilter) query.set('status', statusFilter);
      const response = await apiFetch<{ events: LogItem[]; nextCursor: string | null }>(
        `/api/logs?${query.toString()}`,
      );
      setEvents((current) => [...current, ...response.events]);
      setCursor(response.nextCursor);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not load more logs');
    } finally {
      setLoadingMore(false);
    }
  }

  async function openRow(id: string) {
    try {
      const detail = await apiFetch<LogDetail>(`/api/logs/${id}`);
      setSelected(detail);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not load this event');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <select
        value={statusFilter}
        onChange={(e) => void applyFilter(e.target.value)}
        className="h-9 w-48 rounded-md border border-[var(--border)] bg-white px-3 text-sm"
      >
        <option value="">All statuses</option>
        {['SUCCESS', 'FAILED', 'HELD_NO_CREDIT', 'DROPPED_LOOP', 'REJECTED', 'EXPIRED'].map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--border)] bg-gray-50 text-xs uppercase text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3 font-medium">Time</th>
              <th className="px-4 py-3 font-medium">Relay</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr
                key={event.id}
                onClick={() => void openRow(event.id)}
                className="cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-gray-50"
              >
                <td className="px-4 py-3 text-gray-600">{relativeTime(event.receivedAt)}</td>
                <td className="px-4 py-3 font-medium text-gray-900">{event.relayName}</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[event.status] ?? 'bg-gray-100 text-gray-600'}`}
                  >
                    {statusLabel(event)}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600">
                  {event.status === 'SUCCESS' ? `−${event.cost}` : '—'}
                </td>
              </tr>
            ))}
            {events.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-[var(--muted)]">
                  No events yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {cursor ? (
        <Button
          variant="secondary"
          size="sm"
          className="self-center"
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}

      <DialogRoot open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        {selected ? (
          <DrawerContent
            title={`Event ${selected.event.id.slice(0, 8)}`}
            onClose={() => setSelected(null)}
          >
            <div className="flex flex-col gap-4 text-sm">
              <div>
                <p className="text-xs font-medium uppercase text-[var(--muted)]">Status</p>
                <p className="text-gray-900">{statusLabel(selected.event)}</p>
              </div>
              {selected.payload ? (
                <>
                  <div>
                    <p className="text-xs font-medium uppercase text-[var(--muted)]">
                      Incoming payload
                    </p>
                    <pre className="mt-1 overflow-x-auto rounded bg-gray-50 p-2 text-xs">
                      {JSON.stringify(selected.payload.in, null, 2)}
                    </pre>
                  </div>
                  {selected.payload.out !== null ? (
                    <div>
                      <p className="text-xs font-medium uppercase text-[var(--muted)]">
                        Outgoing payload
                      </p>
                      <pre className="mt-1 overflow-x-auto rounded bg-gray-50 p-2 text-xs">
                        {JSON.stringify(selected.payload.out, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                  {selected.payload.responseExcerpt ? (
                    <div>
                      <p className="text-xs font-medium uppercase text-[var(--muted)]">Response</p>
                      <pre className="mt-1 overflow-x-auto rounded bg-gray-50 p-2 text-xs">
                        {selected.payload.responseExcerpt}
                      </pre>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-[var(--muted)]">Payload deleted after 30 days.</p>
              )}
              <div>
                <p className="text-xs font-medium uppercase text-[var(--muted)]">Attempts</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {selected.attempts.map((a) => (
                    <li key={a.attemptNo} className="rounded bg-gray-50 px-2 py-1 text-xs">
                      #{a.attemptNo} — {a.ok ? 'ok' : (a.errorCode ?? 'failed')}
                      {a.statusCode ? ` (HTTP ${a.statusCode})` : ''}
                      {a.durationMs ? ` — ${a.durationMs}ms` : ''}
                    </li>
                  ))}
                  {selected.attempts.length === 0 ? (
                    <li className="text-xs text-[var(--muted)]">No delivery attempts yet.</li>
                  ) : null}
                </ul>
              </div>
            </div>
          </DrawerContent>
        ) : null}
      </DialogRoot>
    </div>
  );
}
