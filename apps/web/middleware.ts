import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

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
  if (process.env.NODE_ENV !== 'production') return NextResponse.next();

  const canonical = getCanonicalHost();
  if (!canonical) return NextResponse.next();

  const requestHost = req.nextUrl.host; // may include port
  const [hostname, port] = requestHost.split(':');

  if (hostname === `www.${canonical}`) {
    const url = req.nextUrl.clone();
    url.hostname = canonical;
    if (port) url.port = port;
    return NextResponse.redirect(url, 301);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

