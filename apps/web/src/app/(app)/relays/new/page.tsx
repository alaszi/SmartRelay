import { NewRelayWizard } from '@/components/new-relay-wizard';

export default function NewRelayPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-gray-900">New Relay</h1>
      <NewRelayWizard />
    </div>
  );
}
