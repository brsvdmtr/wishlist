import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const repoRoot = process.cwd();
const gitDir = path.join(repoRoot, ".git");
const hooksPath = path.join(repoRoot, ".githooks");
const postCommitHook = path.join(hooksPath, "post-commit");

// This script is intentionally best-effort and must never break installs.
if (!existsSync(gitDir)) process.exit(0);
if (!existsSync(postCommitHook)) process.exit(0);

try {
  chmodSync(postCommitHook, 0o755);
} catch {
  // ignore
}

try {
  execSync("git config core.hooksPath .githooks", { stdio: "ignore" });
} catch {
  // ignore
}
