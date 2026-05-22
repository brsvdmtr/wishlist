import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Source-in-place workspace packages; Next transpiles their TS/TSX directly.
  transpilePackages: ['@wishlist/ui', '@wishlist/ui-tokens'],
  env: {
    // Injected at build time — used as a cache-bust marker and debug indicator
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
  outputFileTracingRoot: path.join(__dirname, '../../'),
  eslint: {
    // We lint from the repo root (pnpm lint). Avoid failing builds due to
    // Next's eslint runner not being workspace-aware in a monorepo.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
