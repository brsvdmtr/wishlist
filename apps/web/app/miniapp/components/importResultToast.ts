import { t, type Locale } from '@wishlist/shared';

/** Parse outcome of a URL import — mirrors the API `parseStatus` union. */
export type ImportParseStatus = 'ok' | 'partial' | 'failed';

/** Toast tones this resolver emits — a subset of the Mini App `Toast['kind']`. */
export type ImportToastTone = 'success' | 'info';

/**
 * Maps a URL-import parse outcome to the post-import toast (copy + tone).
 *
 * The three parse statuses each get distinct wording so the user knows what
 * actually landed in the inbox — and, for a failed parse, that no import
 * credit was spent (a domain-stub item is created but the quota counter does
 * NOT move, which otherwise reads as a bug):
 *   • ok      — fully parsed card → success tone, "Card created!"
 *   • partial — card created, a field is missing → success tone, "check it"
 *   • failed  — only a domain stub, NO credit charged → info tone
 *
 * Shared resolver so the state→copy mapping lives in one tested place rather
 * than as an inline branch in MiniApp.tsx's `handleImportUrl`.
 */
export function importResultToast(
  parseStatus: ImportParseStatus,
  locale: Locale,
): { message: string; tone: ImportToastTone } {
  if (parseStatus === 'failed') {
    return { message: t('drafts_card_created_unparsed', locale), tone: 'info' };
  }
  if (parseStatus === 'partial') {
    return { message: t('drafts_card_created_partial', locale), tone: 'success' };
  }
  return { message: t('drafts_card_created', locale), tone: 'success' };
}
