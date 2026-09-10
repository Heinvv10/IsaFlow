import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import type {HistoricalImportKind} from './historicalImportTypes';
export async function assertHistoricalImportAuthority(ctx:ControlTx,kind:HistoricalImportKind,access:'read'|'write'){
 assertControlTx(ctx);
 if(ctx.principal.authMethod==='platform_import'){
  await assertEffectivePermission(ctx,access==='write'?'write:imports':'read:imports');
  await assertEffectivePermission(ctx,['customer_invoice','supplier_invoice'].includes(kind)?'read:invoices':'read:reports');
  return;
 }
 if(!['cookie','pat','oauth'].includes(ctx.principal.authMethod))throw new Error('Historical imports require authenticated member authority');
 await assertEffectivePermission(ctx,access==='write'?'write:imports':'read:imports');
 const invoice=kind==='customer_invoice'||kind==='supplier_invoice';
 await assertEffectivePermission(ctx,access==='write'?(invoice?'write:invoices':'write:journals'):(invoice?'read:invoices':'read:reports'));
 if(access==='write')await assertEffectivePermission(ctx,'write:post');
}
