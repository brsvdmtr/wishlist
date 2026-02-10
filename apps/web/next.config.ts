import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(appRoot, "../..");

const nextConfig: NextConfig = {
  turbopack: {
    // Monorepo root so Turbopack can resolve the hoisted `next` dependency.
    root: workspaceRoot,
  },
};

export default nextConfig;
