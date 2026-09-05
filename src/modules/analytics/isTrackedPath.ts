/** The public share page is third-party-facing: no path or IP capture there.
 *
 *  Two reasons, either sufficient. The tracker sends `location.pathname`, and
 *  on `/share/<token>` the pathname IS the credential — live tokens were found
 *  in `analytics_events.url_path`, readable by anyone with analytics access.
 *  And the person opening a shared pack is a third party who never agreed to
 *  be measured.
 *
 *  Takes Next's route (`/share/[token]`) as readily as a resolved path, since
 *  that is what `_app` holds. `/sharepoint` and `/shared-with-me` stay tracked:
 *  the boundary is the path SEGMENT, not the prefix.
 */
export function isTrackedPath(pathname: string): boolean {
  return !(pathname === '/share' || pathname.startsWith('/share/'));
}
