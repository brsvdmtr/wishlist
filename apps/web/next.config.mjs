import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Source-in-place workspace packages; Next transpiles their TS/TSX directly.
  transpilePackages: ['@wishlist/ui', '@wishlist/ui-tokens'],
  // Removed `env.NEXT_PUBLIC_BUILD_TIME: new Date().toISOString()` — it
  // forced webpack to emit a fresh chunk hash on every rebuild even when
  // source was identical. That amplified the stale-HTML 404 problem
  // (cached HTML referencing chunks that no longer exist on origin).
  // The two consumers (MiniApp.tsx, SettingsRoot.tsx debug rows) now
  // read NEXT_PUBLIC_APP_RELEASE directly — it's the deployed short SHA,
  // already inlined via the Dockerfile build arg, and more informative
  // than a build timestamp anyway. See docs/BUGFIX_LESSONS.md (2026-05-27).
  outputFileTracingRoot: path.join(__dirname, '../../'),
  eslint: {
    // We lint from the repo root (pnpm lint). Avoid failing builds due to
    // Next's eslint runner not being workspace-aware in a monorepo.
    ignoreDuringBuilds: true,
  },
  experimental: {
    // Rewrites `import { x } from '<pkg>'` to deep imports so unused
    // barrel exports don't end up in the Mini App bundle. Workspace
    // packages benefit the most — @wishlist/shared re-exports zod
    // schemas, i18n tables, analytics events, etc.
    optimizePackageImports: ['@wishlist/shared', '@wishlist/ui'],
  },
};

export default nextConfig;
