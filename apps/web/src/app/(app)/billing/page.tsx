import { BillingView } from '@/components/billing-view';
import { apiFetchServer } from '@/lib/api-server';

interface Topup {
  id: string;
  amount: string;
  status: string;
  createdAt: string;
}

export default async function BillingPage() {
  const { balance, topups } = await apiFetchServer<{ balance: string; topups: Topup[] }>(
    '/api/billing/history',
  );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-gray-900">Billing</h1>
      <BillingView balance={balance} topups={topups} />
    </div>
  );
}
