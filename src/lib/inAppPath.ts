/**
 * An in-app link: a path on this site ('/accounting/...'), never a scheme ('https:', 'javascript:')
 * and never protocol-relative ('//host', '/\host', which browsers read as another host). The same
 * rule as migration 954's `user_notifications.href` CHECK. Pure: the bell (client) and the
 * notification service (server) both use it.
 */
export function isInAppPath(href: string): boolean {
  return href.length <= 500 && href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\');
}
