/**
 * Rejection copy for the OAuth consent screen.
 *
 * Every string the rejection screen shows must be chosen by us, never by the
 * request. `/oauth/authorize` is reached by following a link, and the screen
 * that says "Authorisation request rejected" is ISAFlow-branded, so a message
 * built from a query-string value hands an attacker a sentence on our page.
 *
 * The scope token was the one value that reached it: `Unknown scope: ${s}`.
 * It cannot contain whitespace or a comma (the caller splits on `/[\s,]+/`),
 * but every other code point is fair game — U+00A0 and hyphens join words
 * fine — and there was no length cap. React escaped it, so it was content
 * injection rather than XSS: no script, just our voice saying something we
 * did not say.
 *
 * The fix is a constant. Escaping would not have helped, because the problem
 * was never the markup; and a length cap or a character allow-list would only
 * shorten the attacker's sentence. The rejected token still needs to reach a
 * developer who mistyped a scope, so the caller logs it — a log line is read
 * by us, not by the victim.
 */
export const UNKNOWN_SCOPE_MESSAGE =
  'This app requested a permission ISAFlow does not recognise. Nothing was shared.';

export function rejectionForUnknownScope(_scope: string): string {
  return UNKNOWN_SCOPE_MESSAGE;
}
