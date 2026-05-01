// MUST be the first import in apps/api/src/index.ts.
//
// Prefer IPv6 for Telegram API — Timeweb VPS periodically loses IPv4
// connectivity to Telegram DC2 (149.154.166.110) while IPv6 stays up.
// See docs/CLAUDE.md "infra_ipv6_telegram" memory and infra notes.
//
// This is a side-effect-only module. Do not add re-exports or runtime checks
// that depend on env, because env loading happens in ./env which is imported
// after this one.

import dns from 'node:dns';

dns.setDefaultResultOrder('ipv6first');
