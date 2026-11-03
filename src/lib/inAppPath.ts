/**
 * An in-app link: a path on this site ('/accounting/...'), never a scheme ('https:', 'javascript:')
 * and never protocol-relative ('//host', '/\host', which browsers read as another host). No control
 * character (C0, DEL, C1) and no white space anywhere: a URL parser strips tab, LF and CR, so
 * '/<TAB>/evil.com' would navigate to //evil.com. Migration 954's `user_notifications.href` CHECK
 * holds the same rule (this one is stricter only on Unicode spaces such as U+00A0). Pure: the bell
 * (client) and the notification service (server) both use it.
 */
const UNSAFE = /[\u0000- \u007f-\u009f\s]/;

export function isInAppPath(href: string): boolean {
  return href.length <= 500 && href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\') && !UNSAFE.test(href);
}
