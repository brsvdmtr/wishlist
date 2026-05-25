// Tiny stable reference to the most recent release note id.
// Imported into MiniApp.tsx so the full RELEASE_NOTES array can stay
// out of the main chunk (it lives in release-notes.ts, eagerly imported
// only by the lazy ChangelogScreen).
//
// HAND-SYNC when adding to RELEASE_NOTES: bump this string to the new
// top entry's `id`. Tree-shaking cannot prove only the id is needed
// otherwise the whole array gets pulled into the main chunk via the
// transitive import.

export const LATEST_RELEASE_ID: string | null = '2026-05-21';
