/** The public share page is third-party-facing: no path or IP capture there.
 *
 *  Two reasons, either sufficient. The tracker sends `location.pathname`, and
 *  on `/share/<token>` the pathname IS the credential — live tokens were found
 *  in `analytics_events.url_path`, readable by anyone with analytics access.
 *  And the person opening a shared pack is a third party who never agreed to
 *  be measured.
 *
 *  Derived from `isSharePath` rather than restating it: the share page is the
 *  only thing excluded from tracking today, and if that ever stops being true
 *  the extra reason belongs here, not in a second copy of the same predicate.
 */
import { isSharePath } from '@/lib/paths/isSharePath';

export function isTrackedPath(pathname: string): boolean {
  return !isSharePath(pathname);
}
