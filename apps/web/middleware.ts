import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

let didLogDev = false;

function getCanonicalHost() {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;
  if (!raw) return null;

  try {
    const host = new URL(raw).hostname;
    return host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function middleware(req: NextRequest) {
  if (process.env.NODE_ENV !== 'production') {
    if (!didLogDev) {
      didLogDev = true;
      // eslint-disable-next-line no-console
      console.log('[middleware] dev: pass-through');
    }
    return NextResponse.next();
  }

  const requestHost = req.headers.get('host') ?? req.nextUrl.host; // may include port
  const [hostnameRaw, port] = requestHost.split(':');
  const hostname = hostnameRaw ?? '';

  if (hostname.startsWith('www.')) {
    const url = req.nextUrl.clone();
    url.hostname = getCanonicalHost() ?? hostname.replace(/^www\./, '');
    if (port) url.port = port;
    return NextResponse.redirect(url, 301);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
