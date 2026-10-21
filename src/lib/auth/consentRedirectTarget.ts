/**
 * Describes, for the consent screen, where an authorisation code would actually
 * be sent.
 *
 * The screen's other identity signals are weak against a hostile registrant:
 * the name is whatever they typed, and the unverified-app warning denies
 * verification rather than operation. The redirect target is the one field they
 * cannot author freely — it is registered up front and checked against that
 * registration before this page renders.
 *
 * How much it is worth depends on the client, so the two cases are described
 * differently rather than uniformly:
 *
 *  - A hosted client redirects to a domain someone had to buy and keep serving.
 *    "claude.ai" is a fact the reader can check, so show it.
 *  - A client on the reader's own machine redirects to a loopback address on a
 *    port the operating system handed out. "localhost:57526" identifies nobody
 *    — the legitimate client and a hostile one look identical — so showing it
 *    would imply a check the reader cannot actually make. So the line states
 *    the category and its own limit: a program on this computer, and that we
 *    cannot say which one. Saying only the category read as reassurance —
 *    malware is also a program running on this computer. Never show the port;
 *    it carries no meaning and reads like one.
 *  - A native app's private-use scheme (RFC 8252 s7.1) is accepted only from
 *    the exact allowlist in `oauthNativeRedirects.ts`, so the app it belongs to
 *    is known and can be named, with the scheme and authority beside it. Any
 *    other custom scheme stays `unknown`.
 */
import { isLoopbackHost } from '@/lib/auth/oauthLoopback';
import { describeNativeRedirect } from '@/lib/auth/oauthNativeRedirects';

export type ConsentRedirectTarget =
  | { kind: 'web'; host: string }
  | { kind: 'local' }
  | { kind: 'native'; appLabel: string; target: string }
  | { kind: 'unknown' };

export function describeRedirectTarget(redirectUri: string): ConsentRedirectTarget {
  const native = describeNativeRedirect(redirectUri);
  if (native) return { kind: 'native', appLabel: native.appLabel, target: native.target };

  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    // Registration rejects anything unparseable, so this is unreachable from a
    // registered app. Fall back to saying nothing rather than to a guess.
    return { kind: 'unknown' };
  }

  if (url.protocol === 'https:') return { kind: 'web', host: url.host };
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return { kind: 'local' };
  return { kind: 'unknown' };
}
