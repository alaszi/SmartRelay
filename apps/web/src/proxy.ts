import { NextResponse, type NextRequest } from 'next/server';

// Must match apps/api/src/session.ts's SESSION_COOKIE. Presence-only: this is a fast redirect for
// UX, not the source of truth — every protected page still calls GET /api/me server-side, which is
// the only thing that actually validates the session.
const SESSION_COOKIE = 'sr_session';

const PROTECTED_PREFIXES = ['/dashboard', '/relays', '/logs', '/billing'];

export function proxy(request: NextRequest) {
  const isProtected = PROTECTED_PREFIXES.some((prefix) =>
    request.nextUrl.pathname.startsWith(prefix),
  );
  if (isProtected && !request.cookies.has(SESSION_COOKIE)) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/relays/:path*', '/logs/:path*', '/billing/:path*'],
};
