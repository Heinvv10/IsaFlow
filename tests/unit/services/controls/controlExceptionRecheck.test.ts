import {expect,it,vi} from 'vitest';
const check=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:()=>Promise.resolve()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:()=>{}}));
vi.mock('@/modules/accounting/services/controls/threeWayMatchChecks',()=>({checkThreeWayMatchExceptions:check}));
import {runExceptionCheck} from '@/modules/accounting/services/controls/controlExceptionRecheck';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const ctx={} as ControlTx;
it('dispatches the stored check ID to the fixed real service adapter, retaining caller pagination',async()=>{
 const result={status:'fail',findings:[{key:'real-adapter-result'}]};check.mockResolvedValue(result);
 expect(await runExceptionCheck(ctx,{checkId:'three_way_match_exceptions',cursor:'page',cutoff:'2026-09-09',limit:10})).toBe(result);
 expect(check).toHaveBeenLastCalledWith(ctx,{cursor:'page',cutoff:'2026-09-09',limit:10});
});
it('rejects user-supplied callbacks or result overrides',async()=>{
 for(const extra of [{result:{status:'pass'}},{checker:()=>({status:'pass'})}])await expect(runExceptionCheck(ctx,{checkId:'three_way_match_exceptions',...extra})).rejects.toThrow();
});
