import { requireControlTx } from '@/modules/accounting/services/controls/context';
import { resolveEffectivePermissions } from '@/lib/auth/effectivePermissions';
import type { McpTool, McpToolContext } from './types';

/** Token scopes are only a ceiling; current tenant authority also gates every replay. */
export async function assertCurrentToolAuthority(
  tool: Pick<McpTool, 'name' | 'scope' | 'write' | 'requiresPost'>, supplied: McpToolContext,
): Promise<void> {
  const ctx = requireControlTx(), p = ctx.principal;
  if (!['pat','oauth'].includes(p.authMethod) || p.companyId !== supplied.companyId
    || p.personId !== supplied.userId || p.grantId !== supplied.tokenJti) {
    throw new Error('Authenticated tool context required');
  }
  const current = await resolveEffectivePermissions(ctx);
  if ((tool.scope !== null && !current.permissions.includes(tool.scope))
    || (tool.requiresPost && !current.permissions.includes('write:post'))) {
    throw new Error('Current permissions do not allow this operation.');
  }
}
