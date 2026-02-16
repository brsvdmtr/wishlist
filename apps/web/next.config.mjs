/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    outputFileTracingRoot: require('path').join(__dirname, '../../'),
  },
  eslint: {
    // We lint from the repo root (pnpm lint). Avoid failing builds due to
    // Next's eslint runner not being workspace-aware in a monorepo.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
