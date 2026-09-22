'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/logs', label: 'Logs' },
  { href: '/billing', label: 'Billing' },
];

export function NavBar({ email, balance }: { email: string; balance: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleSignOut() {
    await apiFetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <header className="border-b border-[var(--border)] bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="font-semibold text-accent-700">
            SmartRelay
          </Link>
          <nav className="flex items-center gap-4">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'text-sm font-medium text-gray-600 hover:text-gray-900',
                  pathname.startsWith(link.href) && 'text-accent-700',
                )}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/billing"
            className="rounded-full bg-accent-50 px-3 py-1 text-sm font-medium text-accent-700"
          >
            Balance: {balance}
          </Link>
          <span className="hidden text-sm text-[var(--muted)] sm:inline">{email}</span>
          <Button variant="ghost" size="sm" onClick={() => void handleSignOut()}>
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
