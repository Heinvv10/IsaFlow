/**
 * safeHref — links that come from props (help text, explanation sources) may only be http(s) or an
 * absolute in-app path. `javascript:`, `data:`, `vbscript:`, protocol-relative `//host` and `/\host`
 * (browsers read both as another origin) are refused, with or without leading whitespace or case tricks.
 */
const EXTERNAL = /^https?:\/\/[^\s]+$/i;
const IN_APP = /^\/(?![/\\])[^\s\\]*$/;

/** The href when it is safe to render as a link, otherwise null. */
export function safeHref(href: string | undefined): string | null {
  if (href === undefined) return null;
  return EXTERNAL.test(href) || IN_APP.test(href) ? href : null;
}

export const isExternalHref = (href: string): boolean => EXTERNAL.test(href);
