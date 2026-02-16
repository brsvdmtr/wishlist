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

/**
 * Basic Auth protection for /admin/* routes
 */
function checkBasicAuth(req: NextRequest): NextResponse | null {
  const { pathname } = req.nextUrl;
  
  // Only protect /admin and /admin/* paths
  if (!pathname.startsWith('/admin')) {
    return null;
  }

  const adminUser = process.env.ADMIN_BASIC_USER;
  const adminPass = process.env.ADMIN_BASIC_PASS;

  // If credentials not configured, block access
  if (!adminUser || !adminPass) {
    console.error('[middleware] ADMIN_BASIC_USER or ADMIN_BASIC_PASS not configured');
    return new NextResponse('Admin credentials not configured', { status: 500 });
  }

  const authHeader = req.headers.get('authorization');

  if (!authHeader) {
    return new NextResponse('Authentication required', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Admin Area"',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  }

  // Parse Basic Auth header
  const base64Credentials = authHeader.split(' ')[1];
  if (!base64Credentials) {
    return new NextResponse('Invalid authorization header', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Admin Area"',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  }

  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
  const [username, password] = credentials.split(':');

  if (username !== adminUser || password !== adminPass) {
    return new NextResponse('Invalid credentials', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Admin Area"',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  }

  // Auth successful, continue with noindex header
  return null; // Will be handled by main middleware
}

export function middleware(req: NextRequest) {
  // Check Basic Auth for /admin routes first
  const authResponse = checkBasicAuth(req);
  if (authResponse) {
    return authResponse;
  }

  // WWW redirect (production only)
  if (process.env.NODE_ENV === 'production') {
    const requestHost = req.headers.get('host') ?? req.nextUrl.host;
    const [hostnameRaw, port] = requestHost.split(':');
    const hostname = hostnameRaw ?? '';

    if (hostname.startsWith('www.')) {
      const url = req.nextUrl.clone();
      url.hostname = getCanonicalHost() ?? hostname.replace(/^www\./, '');
      if (port) url.port = port;
      return NextResponse.redirect(url, 301);
    }
  }

  // Add noindex header for /admin routes
  if (req.nextUrl.pathname.startsWith('/admin')) {
    const response = NextResponse.next();
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return response;
  }

  if (process.env.NODE_ENV !== 'production' && !didLogDev) {
    didLogDev = true;
    // eslint-disable-next-line no-console
    console.log('[middleware] dev: Basic Auth + www redirect enabled');
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
