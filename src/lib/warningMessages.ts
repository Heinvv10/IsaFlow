/**
 * One reading of a server's list of warnings, for every screen that shows one
 * (the posting-warnings notice and the bulk import). COERCED, never dropped: a
 * lone value is a list of one, an element that is not a string becomes its text
 * (an object by its first non-empty `error` or `message`, else as JSON). But a
 * value that says nothing — blank, `{}`, `[]`, `{ warnings: [] }`, a boolean, `0`,
 * null — is no warning, so a clean
 * answer never reads "with problems". Trimmed; repeats removed.
 */
/** Does a value say anything? Booleans, 0, null, blanks and empty containers do not. */
const hasContent = (e: unknown): boolean => {
  if (typeof e === 'string') return e.trim() !== '';
  if (typeof e === 'number') return e !== 0 && !Number.isNaN(e);
  if (Array.isArray(e)) return e.some(hasContent);
  if (typeof e === 'object' && e !== null) return Object.values(e).some(hasContent);
  return false;
};

const text = (e: unknown): string => {
  if (typeof e === 'string') return e.trim();
  if (!hasContent(e)) return '';
  if (Array.isArray(e)) return warningMessages(e).join('; ');
  if (typeof e === 'object' && e !== null) {
    const o = e as { error?: unknown; message?: unknown };
    for (const f of [o.error, o.message]) if (typeof f === 'string' && f.trim() !== '') return f.trim();
    return JSON.stringify(e);
  }
  return String(e);
};

export const warningMessages = (v: unknown): string[] =>
  [...new Set((Array.isArray(v) ? v : [v]).map(text).filter((w) => w !== ''))];
