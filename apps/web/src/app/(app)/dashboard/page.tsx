import Link from 'next/link';
import { GoogleConnectionNotice } from '@/components/google-connection-notice';
import { Button } from '@/components/ui/button';
import { RelayTable } from '@/components/relay-table';
import { apiFetchServer } from '@/lib/api-server';
import type { RelaySummary } from '@/lib/relay-types';

export default async function DashboardPage() {
  const { relays } = await apiFetchServer<{ relays: RelaySummary[] }>('/api/relays');

  return (
    <div className="flex flex-col gap-6">
      <GoogleConnectionNotice />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Relays</h1>
        <Button asChild>
          <Link href="/relays/new">+ New Relay</Link>
        </Button>
      </div>
      <RelayTable relays={relays} />
    </div>
  );
}
