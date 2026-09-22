import { LogsView } from '@/components/logs-view';
import { apiFetchServer } from '@/lib/api-server';

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

export default async function LogsPage() {
  const { events, nextCursor } = await apiFetchServer<{
    events: LogItem[];
    nextCursor: string | null;
  }>('/api/logs');

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-gray-900">Logs</h1>
      <LogsView initialEvents={events} initialCursor={nextCursor} />
    </div>
  );
}
