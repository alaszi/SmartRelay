import { notFound } from 'next/navigation';
import { EditRelayView } from '@/components/edit-relay-view';
import { ApiError } from '@/lib/api-shared';
import { apiFetchServer } from '@/lib/api-server';
import type { RelaySummary } from '@/lib/relay-types';

export default async function EditRelayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { relay } = await apiFetchServer<{ relay: RelaySummary & { emailAddress?: string } }>(
      `/api/relays/${id}`,
    );
    return <EditRelayView relay={relay} />;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
}
