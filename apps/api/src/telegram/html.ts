// Escape user-controlled strings for safe interpolation inside Telegram HTML
// parse_mode. Telegram HTML is tag-based (`<b>`, `<i>`, `<blockquote>`, etc.),
// so the only characters that need escaping in interpolated values are
// `&`, `<`, `>`. Quote escaping is unnecessary because attribute values
// don't appear in our notification text.

export function escapeTgHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
