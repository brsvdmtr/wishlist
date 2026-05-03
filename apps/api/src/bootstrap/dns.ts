// MUST be the first import in apps/api/src/index.ts.
//
// Prefer IPv4 for Telegram API on the Vultr production host. Container IPv4 to
// api.telegram.org is healthy there, while container IPv6 is not available.
// Override with DNS_RESULT_ORDER only after validating connectivity from inside
// the Docker network.
//
// This is a side-effect-only module. Do not add re-exports or runtime checks
// that depend on env, because env loading happens in ./env which is imported
// after this one.

import dns from 'node:dns';

type DnsResultOrder = Parameters<typeof dns.setDefaultResultOrder>[0];

function resolveDnsResultOrder(value: string | undefined): DnsResultOrder {
  if (value === 'ipv4first' || value === 'ipv6first' || value === 'verbatim') return value;
  return 'ipv4first';
}

dns.setDefaultResultOrder(resolveDnsResultOrder(process.env.DNS_RESULT_ORDER));
