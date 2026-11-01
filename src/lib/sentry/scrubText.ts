// src/lib/sentry/scrubText.ts: text-level redaction for Sentry payloads: DOM selectors and URLs.
import { keyMayBeData } from '@/lib/sanitizeRequestBody';
import { redactShareToken } from '@/lib/observability/redactShareToken';

export const REDACTED = '[REDACTED]';

// Sentry's ui.click / ui.input breadcrumbs describe the element as a selector (@sentry/core _htmlElementAsString):
// `tag#id.class` then `[aria-label="…"][type="…"][name="…"][title="…"][alt="…"]`, plus whatever `serializeAttribute`
// names. Values are written UNESCAPED, so a value may hold any terminator (`"]`, `[type="text"]`, ` > b.`) and no
// scan can say where it ends. So none tries: everything from the first `[attr="` to the end of the message goes. The
// path before it (tags, ids, classes) stays for debugging, and so does the first attribute's name. Grid controls are
// named after their row (date, payee, amount) and a note's title is the note, so every attribute value is customer data.
const ATTR_OPEN_RE = /\[([A-Za-z_:][\w:.-]*)="/;

export function redactDomAttrs(text: string): string {
  const open = ATTR_OPEN_RE.exec(text);
  return open ? `${text.slice(0, open.index)}[${open[1]}="${REDACTED}"]` : text;
}

/** `a=1&b` -> `a=[REDACTED]&[REDACTED]`: keys stay, every value goes; a pair with no "=" is itself a value. A value
 *  redactShareToken already masked stays `[token]`. */
export function redactQueryValues(query: string): string {
  return query.split('&').map((pair) => {
    if (pair === '') return pair;
    const eq = pair.indexOf('=');
    if (eq === -1 || keyMayBeData(pair.slice(0, eq))) return REDACTED;
    return pair.slice(eq + 1) === '[token]' ? pair : `${pair.slice(0, eq)}=${REDACTED}`;
  }).join('&');
}

/** A whole URL: share token masked, query values gone (keys and path stay), fragment gone (a reset link keeps its token there). */
export function scrubUrl(url: string): string {
  const masked = redactShareToken(url);
  const hash = masked.indexOf('#');
  const base = hash === -1 ? masked : masked.slice(0, hash);
  const q = base.indexOf('?');
  const path = q === -1 ? base : `${base.slice(0, q + 1)}${redactQueryValues(base.slice(q + 1))}`;
  if (hash === -1) return path;
  return `${path}#${hash === masked.length - 1 ? '' : REDACTED}`;
}

// A URL inside free text: absolute, or from the first "/" of a path (`api/x?q=1` too). Harmless on `a/b` or `1/2`: scrubUrl only touches "?" and "#".
// It stops at "[" and "]" (a selector's attribute opens there), except the masks `[token]` and `[REDACTED]`.
const URL_CHAR = '(?:[^\\s"\'<>`\\[\\]]|\\[token\\]|\\[REDACTED\\])';
const URL_IN_TEXT_RE = new RegExp(`https?://${URL_CHAR}+|/${URL_CHAR}*`, 'g');

export function redactUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT_RE, scrubUrl);
}

/** Free text (an exception, a message): a selector is cut at its first attribute, then URLs lose their query values and
 *  fragment. The cut goes first: an unescaped value can hold a "/" or a "?", and a URL match must never eat the
 *  `[attr="` that opens it. */
export function scrubText(text: string): string {
  return redactUrlsInText(redactDomAttrs(text));
}
