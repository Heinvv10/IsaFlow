/** The public share page is third-party-facing: no path or IP capture there.
 *
 *  Two reasons, either sufficient. The tracker sends `location.pathname`, and
 *  on `/share/<token>` the pathname IS the credential — live tokens were found
 *  in `analytics_events.url_path`, readable by anyone with analytics access.
 *  And the person opening a shared pack is a third party who never agreed to
 *  be measured.
 *
 *  Derived from `isSharePath` rather than restating it.
 *
 *  The employee self-service portal (wave 6 SS, review #1576 M1) is excluded too:
 *  its visitors are a company's employees, not IsaFlow users, who never agreed
 *  to be measured, and its pages carry payroll personal data (the tracker sent
 *  `document.title`, which named the employee). The boundary is the segment.
 */
import { isSharePath } from '@/lib/paths/isSharePath';

export function isTrackedPath(pathname: string): boolean {
  return !isSharePath(pathname) && pathname !== '/employee-portal' && !pathname.startsWith('/employee-portal/');
}
