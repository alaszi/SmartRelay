import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { NavBar } from '@/components/nav-bar';
import { getCurrentUser } from '@/lib/api-server';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar email={user.email} balance={user.balance} />
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}
