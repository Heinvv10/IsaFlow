/**
 * The intercompany routes of the route registry (P1), kept beside `apiRoutes.ts` so the registry stays under the
 * file-size limit; `StaticRoutes` and `DynamicRoutes` there extend these. Same rules as the registry: one type per
 * URL, taken from the service, `{}` binds one segment. Every import is `import type`.
 */
import type { ConnectionView, GroupCandidate, SideOptions } from '@/modules/accounting/services/intercompany/connectionTypes';
import type { PairingResult, PairingView } from '@/modules/accounting/services/intercompany/pairingTypes';

export interface IntercompanyStaticRoutes {
  // GET the list (`items`), POST the new connection: the list and the item of one resource, disjoint on `items`.
  '/api/accounting/intercompany/connections': { items: ConnectionView[]; count: number } | ConnectionView;
  '/api/accounting/intercompany/group-candidates': { items: GroupCandidate[]; count: number };
  '/api/accounting/intercompany/side-options': SideOptions;
}

export interface IntercompanyDynamicRoutes {
  // PUT (edit this company's side) and DELETE (revoke) both answer with the connection.
  '/api/accounting/intercompany/connections/{}': ConnectionView;
  // PUT the pair's agreement (mode, cut-over, interest): answers with the connection.
  '/api/accounting/intercompany/connections/{}/settings': ConnectionView;
  // GET the pairing screen's data; POST records pairs (answers with the counts).
  '/api/accounting/intercompany/connections/{}/pairing': PairingView | PairingResult;
  // PUT confirms the partner's proposal, DELETE unlinks: both answer with the link's new status.
  '/api/accounting/intercompany/connections/{}/pairing/links/{}': { status: string };
}
