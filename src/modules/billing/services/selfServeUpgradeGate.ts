/**
 * The dark feature flag `trial_self_serve_upgrade` (migration 1041): a tenant
 * owner upgrading their own trial company to a paid plan
 * (/api/billing/upgrade/*, /accounting/settings/billing/upgrade). Off for every
 * company (is_global false, in no plan) until a platform admin sets a
 * company_feature_overrides row on the admin features page.
 *
 * With the flag off every upgrade route answers 404 for every role, before the
 * role gate, so the surface does not exist for a company without it.
 *
 * ONE flag read per request (`hasFeature`: override, then is_global, then the
 * plan), in a savepoint of its own so a read that fails cannot poison the
 * request transaction. FAIL CLOSED: an error answers off, logged by SQLSTATE only.
 */

import type { NextApiResponse } from 'next';
import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { apiResponse } from '@/lib/apiResponse';
import type { CompanyAuthedRequest } from '@/lib/auth';
import { hasFeature } from '@/modules/admin/services/featureFlagService';

export const SELF_SERVE_UPGRADE_FEATURE = 'trial_self_serve_upgrade';

/** Only the company owner upgrades: the subscription is a commitment of the company's money. */
export const UPGRADE_ROLES: readonly string[] = ['owner'];

export async function selfServeUpgradeEnabled(companyId: string): Promise<boolean> {
  try {
    return (await withSavepoint('self_serve_upgrade_flag', () => hasFeature(companyId, SELF_SERVE_UPGRADE_FEATURE))) === true;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    log.warn('Self-serve upgrade flag could not be read: treated as off', {
      companyId, code: typeof code === 'string' ? code : null,
    }, 'selfServeUpgrade');
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => unknown | Promise<unknown>;

/** 404 unless the company has the flag. Wraps the role gate, so a flag-off company sees 404 whatever the role. */
export function withSelfServeUpgradeFlag(handler: Handler): Handler {
  return async (req: CompanyAuthedRequest, res: NextApiResponse) => {
    if (!(await selfServeUpgradeEnabled(req.companyId))) return apiResponse.notFound(res, 'Page');
    return handler(req, res);
  };
}
