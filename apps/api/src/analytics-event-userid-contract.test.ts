// Static regression guard for the AnalyticsEvent.userId contract.
//
// Contract (docs/analytics-events.md): the userId column always stores the
// internal User.id (cuid), never the Telegram numeric ID. Discovered in May
// 2026 that ~88% of historical rows were polluted by /tg/telemetry passing
// `String(req.tgUser.id)` (the Telegram id) into the column — the fix
// normalized every emitter to pass `user.id` (cuid) or `null`.
//
// This test grep's the apps/api + apps/bot source for the specific
// anti-pattern. It fires immediately when someone writes the easy-to-make
// mistake of dropping `String(req.tgUser!.id)` next to a `userId:` key, before
// the regression reaches prod. Zero runtime cost — pure string scan over
// committed source.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ROOTS = [
  path.join(REPO_ROOT, 'apps/api/src'),
  path.join(REPO_ROOT, 'apps/bot/src'),
];

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(p));
    } else if (entry.isFile() && p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

const files = ROOTS.flatMap((r) => (fs.existsSync(r) ? walkTsFiles(r) : []));

describe('AnalyticsEvent.userId contract — static regression guard', () => {
  it('no analytics callsite passes a Telegram numeric id as userId', () => {
    // Pattern: a line that mentions `userId` AND `String(...tgUser...id...)` or
    // `String(ctx.from.id)` on the same line. Allowlist: anything inside a
    // .test.ts (filtered by file extension above), comments-only mentions,
    // and the rate-limit keyGenerator which legitimately keys by Telegram id.
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    const userIdAnalyticsRe = /userId\s*:/;
    const tgIdStringRe = /String\s*\(\s*(req\.tgUser|ctx\.from|tgUser)[^)]*\.id[^)]*\)/;

    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Skip pure comment lines.
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (!userIdAnalyticsRe.test(line)) continue;
        if (!tgIdStringRe.test(line)) continue;
        // keyGenerator for rate limit uses `tgUser.id` legitimately — but it
        // doesn't have a `userId:` key. The combined match here is unique to
        // analytics emitter callsites.
        offenders.push({ file: path.relative(REPO_ROOT, file), line: i + 1, text: line.trim() });
      }
    }

    expect(offenders, `Found ${offenders.length} analytics callsites passing a Telegram numeric id as userId. The AnalyticsEvent.userId contract requires internal User.id (cuid). Use \`user.id\` (after getOrCreateTgUser) or \`resolveTgUserId(req.tgUser?.id)\` for the read-only lookup. Offenders:\n${offenders.map(o => `  ${o.file}:${o.line}  ${o.text}`).join('\n')}`).toEqual([]);
  });

  it('no analytics callsite passes a Telegram-id-derived variable as userId', () => {
    // Indirect-variable variant of the first test. The first test catches the
    // single-line callsite `userId: String(req.tgUser!.id)`. This one catches:
    //
    //   const tgUserId = String(req.tgUser.id);  // <-- declaration
    //   ...
    //   trackAnalyticsEvent({ event: '...', userId: tgUserId, ... });  // <-- usage
    //
    // i.e. the variable holds a stringified Telegram id, then later flows into
    // an analytics `userId:` slot. This was the live regression on
    // search.routes.ts:142 in the May 2026 fix wave (the bulk normalization
    // missed it because the declaration and the usage sit on different lines).
    //
    // Per-file scope: collect variable names whose declaration includes
    // `String(req.tgUser...id...)` / `String(ctx.from.id)` / `String(tgUser.id)`;
    // then in the same file look for `userId: <var>` lines.
    const tgIdStringDeclRe = /\b(?:const|let|var)\s+(\w+)\s*=[^;]*String\s*\(\s*(?:req\.tgUser|ctx\.from|tgUser)[^)]*\.id[^)]*\)/;
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      const taintedVars = new Set<string>();
      for (const raw of lines) {
        const m = raw.match(tgIdStringDeclRe);
        if (m) taintedVars.add(m[1]!);
      }
      if (taintedVars.size === 0) continue;
      const userIdAssignRe = /userId\s*:\s*(\w+)\b/;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        const m = line.match(userIdAssignRe);
        if (!m) continue;
        if (taintedVars.has(m[1]!)) {
          offenders.push({ file: path.relative(REPO_ROOT, file), line: i + 1, text: trimmed });
        }
      }
    }
    expect(offenders, `Found ${offenders.length} analytics callsites passing a Telegram-id-derived variable as userId. Same contract as the previous test, but the source pattern is multi-line (var holds the stringified Telegram id, then flows into userId:). Replace with \`user.id\` (after getOrCreateTgUser) or \`resolveTgUserId(req.tgUser?.id)\`. Offenders:\n${offenders.map(o => `  ${o.file}:${o.line}  ${o.text}`).join('\n')}`).toEqual([]);
  });

  it('no direct prisma.analyticsEvent.create writes telegramId as userId', () => {
    // Companion check: any prisma.analyticsEvent.create({ data: { userId: telegramId, ... }})
    // pattern where `telegramId` is the variable name conventionally used for
    // the stringified Telegram numeric id (see apps/bot/src/index.ts).
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    const re = /userId\s*:\s*telegramId\b/;
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (re.test(line)) {
          offenders.push({ file: path.relative(REPO_ROOT, file), line: i + 1, text: trimmed });
        }
      }
    }
    expect(offenders, `Found ${offenders.length} writes of \`userId: telegramId\` (the Telegram numeric id) to AnalyticsEvent. The contract requires User.id (cuid). Use \`user?.id ?? null\` after the User upsert, or \`resolveTgUserId(telegramId)\` for read-only lookup. Offenders:\n${offenders.map(o => `  ${o.file}:${o.line}  ${o.text}`).join('\n')}`).toEqual([]);
  });
});
