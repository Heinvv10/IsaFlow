/**
 * One reading of a server's list of warnings, for every screen that shows one
 * (the posting-warnings notice and the bulk import). COERCED, never dropped: a
 * lone value is a list of one, an element that is not a string becomes its text
 * (an object by its `error` or `message`, else as JSON). But a value that says
 * nothing — blank, `{}`, `[]`, `false`, `0`, null — is no warning, so a clean
 * answer never reads "with problems". Trimmed; repeats removed.
 */
const text = (e: unknown): string => {
  if (typeof e === 'string') return e.trim();
  if (e === null || e === undefined || e === false || e === 0 || Number.isNaN(e)) return '';
  if (Array.isArray(e)) return e.length === 0 ? '' : warningMessages(e).join('; ');
  if (typeof e === 'object') {
    const o = e as { error?: unknown; message?: unknown };
    if (typeof o.error === 'string') return o.error.trim();
    if (typeof o.message === 'string') return o.message.trim();
    return Object.keys(o).length === 0 ? '' : JSON.stringify(e);
  }
  return String(e);
};

export const warningMessages = (v: unknown): string[] =>
  [...new Set((Array.isArray(v) ? v : [v]).map(text).filter((w) => w !== ''))];
