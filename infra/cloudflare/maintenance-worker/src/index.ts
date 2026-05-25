// WishBoard maintenance worker.
// Routes traffic for the prod zone; serves the canonical maintenance HTML
// when origin is unreachable, and buffers Telegram-authenticated user
// exposures in KV so the recovery notification still reaches L1 users.
//
// See README.md + docs/MAINTENANCE_FLOW.md.

import { validateInitData } from './initdata';
import { MAINTENANCE_HTML } from './maintenance-html.generated';

export interface Env {
  MAINTENANCE_EXPOSURES: KVNamespace;
  ORIGIN_HOST: string;
  MAINTENANCE_WORKER_DISABLED: string;
  BOT_TOKEN: string;
  CF_DRAIN_SECRET: string;
}

// Cloudflare-side and origin-side codes that mean "origin is unhealthy".
// 520-527: Cloudflare-generated codes for various origin issues.
// 502/503/504: nginx or upstream gateway errors that survived to CF.
const ORIGIN_FAILURE_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527]);

const KV_KEY_PREFIX = 'exposure:';
const KV_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Kill switch — pure pass-through.
    if (env.MAINTENANCE_WORKER_DISABLED === '1') {
      return fetch(req);
    }

    const url = new URL(req.url);
    const pathname = url.pathname;

    // ── Worker-owned endpoints (never proxied) ──
    if (pathname === '/__cf-maintenance-health') {
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (pathname === '/__cf-maintenance-exposure') {
      if (req.method !== 'POST') return jsonResp({ ok: false, reason: 'method_not_allowed' }, 405);
      return handleExposure(req, env);
    }

    if (pathname === '/__cf-maintenance-drain') {
      if (req.method === 'GET') return handleDrain(req, env);
      if (req.method === 'DELETE') return handleDrainDelete(req, env);
      return jsonResp({ ok: false, reason: 'method_not_allowed' }, 405);
    }

    // ── Pass-through with origin-failure fallback ──
    let originResp: Response;
    try {
      originResp = await fetch(req);
    } catch (err) {
      return serveFallbackOrPassthroughError(req, err);
    }

    if (ORIGIN_FAILURE_STATUSES.has(originResp.status) && wantsHtml(req)) {
      return serveMaintenanceHtml();
    }
    return originResp;
  },
} satisfies ExportedHandler<Env>;

// ── Handlers ────────────────────────────────────────────────────────────────

async function handleExposure(req: Request, env: Env): Promise<Response> {
  if (!env.BOT_TOKEN) {
    return jsonResp({ ok: false, reason: 'no_bot_token' }, 503);
  }

  let initData = '';
  let surface = 'static';
  let locale = '';

  try {
    const ct = (req.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/x-www-form-urlencoded')) {
      const body = await req.text();
      const params = new URLSearchParams(body);
      initData = params.get('initData') || '';
      surface = clip(params.get('surface') || 'static', 32);
      locale = clip(params.get('locale') || '', 16);
    } else if (ct.includes('application/json')) {
      const body = (await req.json()) as { initData?: unknown; surface?: unknown; locale?: unknown };
      initData = String(body.initData ?? '');
      surface = clip(String(body.surface ?? 'static'), 32);
      locale = clip(String(body.locale ?? ''), 16);
    } else {
      return jsonResp({ ok: false, reason: 'bad_content_type' }, 415);
    }
  } catch {
    return jsonResp({ ok: false, reason: 'bad_body' }, 400);
  }

  if (!initData) return jsonResp({ ok: false, reason: 'missing_initData' }, 400);

  const validated = await validateInitData(initData, env.BOT_TOKEN);
  if (!validated) return jsonResp({ ok: false, reason: 'invalid_initData' }, 401);

  const userId = validated.user.id;
  // For private Mini App launches (vast majority), chat_id == user.id. For
  // group launches this may be wrong, but the API-side ingest re-resolves
  // telegramChatId from the User record so the buffered value is just a
  // hint, not authoritative.
  const chatId = userId;
  const effectiveLocale = locale || validated.user.language_code || 'ru';

  // One bucket per UTC date — same user hitting maintenance multiple times
  // the same day collapses to a single notification.
  const dateBucket = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `${KV_KEY_PREFIX}${dateBucket}:${userId}`;

  const record = {
    tg_user_id: userId,
    chat_id: chatId,
    locale: effectiveLocale,
    surface,
    ts: new Date().toISOString(),
  };

  await env.MAINTENANCE_EXPOSURES.put(key, JSON.stringify(record), {
    expirationTtl: KV_TTL_SEC,
  });

  return jsonResp({ ok: true });
}

async function handleDrain(req: Request, env: Env): Promise<Response> {
  if (!checkDrainSecret(req, env)) return jsonResp({ ok: false, reason: 'forbidden' }, 403);

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '1000', 10) || 1000, 1000);

  const list = await env.MAINTENANCE_EXPOSURES.list({ prefix: KV_KEY_PREFIX, limit });

  const records: Array<Record<string, unknown> & { _key: string }> = [];
  for (const k of list.keys) {
    const val = await env.MAINTENANCE_EXPOSURES.get(k.name);
    if (!val) continue;
    try {
      const parsed = JSON.parse(val) as Record<string, unknown>;
      records.push({ ...parsed, _key: k.name });
    } catch {
      // skip malformed; will expire on its own via TTL
    }
  }

  return jsonResp({
    ok: true,
    count: records.length,
    has_more: !list.list_complete,
    records,
  });
}

async function handleDrainDelete(req: Request, env: Env): Promise<Response> {
  if (!checkDrainSecret(req, env)) return jsonResp({ ok: false, reason: 'forbidden' }, 403);

  let keys: string[] = [];
  try {
    const body = (await req.json()) as { keys?: unknown };
    if (Array.isArray(body.keys)) {
      keys = body.keys.filter((k): k is string => typeof k === 'string' && k.startsWith(KV_KEY_PREFIX));
    }
  } catch {
    return jsonResp({ ok: false, reason: 'bad_body' }, 400);
  }

  if (keys.length === 0) return jsonResp({ ok: true, deleted: 0 });

  let deleted = 0;
  for (const k of keys) {
    try {
      await env.MAINTENANCE_EXPOSURES.delete(k);
      deleted++;
    } catch {
      // best-effort
    }
  }
  return jsonResp({ ok: true, deleted });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function serveMaintenanceHtml(): Response {
  return new Response(MAINTENANCE_HTML, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '60',
    },
  });
}

function serveFallbackOrPassthroughError(req: Request, _err: unknown): Response {
  if (wantsHtml(req)) return serveMaintenanceHtml();
  // Non-HTML clients (API callers, fetch from JS) get a clean JSON error so
  // they can retry; serving HTML to them would break parsers.
  return new Response(JSON.stringify({ error: 'origin_unreachable' }), {
    status: 502,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function wantsHtml(req: Request): boolean {
  // Require an EXPLICIT text/html in Accept. Browser navigations send
  // "text/html,application/xhtml+xml,..." — they get the maintenance UI.
  // JS fetch() / XHR / curl default to "*/*" — they should get the origin's
  // real JSON response (e.g. {code:MAINTENANCE}) so the Mini App can detect
  // maintenance mode and render the in-app L3 screen with full UX (haptics,
  // exposure POST, etc.) instead of falling into a generic error path.
  const accept = (req.headers.get('accept') || '').toLowerCase();
  return accept.includes('text/html');
}

function jsonResp(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function checkDrainSecret(req: Request, env: Env): boolean {
  if (!env.CF_DRAIN_SECRET) return false;
  const url = new URL(req.url);
  const provided = url.searchParams.get('secret') || req.headers.get('x-drain-secret') || '';
  return constantTimeEqualStr(provided, env.CF_DRAIN_SECRET);
}

function constantTimeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}
