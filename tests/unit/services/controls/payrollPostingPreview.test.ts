import { beforeEach,expect,it,vi } from 'vitest';
const mock=vi.hoisted(()=>({permission:vi.fn(),material:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mock.permission}));
vi.mock('@/modules/accounting/services/controls/payrollOperationMaterializer',()=>({materializePayrollOperation:mock.material}));
import { getPayrollPostingPreview } from '@/modules/accounting/services/controls/payrollPostingPreview';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
const ctx={} as ControlTx;
beforeEach(()=>{vi.clearAllMocks();mock.permission.mockResolvedValue(undefined);mock.material.mockResolvedValue({
  binding:{accountingDate:'2026-09-30',amount:'102',currency:'ZAR'},versionBasis:'recorded_with_current_fingerprint',
  observedSources:[{facts:{header:{status:'calculated'},targetPeriod:{status:'open'},company:{lockdown_enabled:false},employees:[{tax_number:'secret'}],plan:{lines:[{glAccountId:'account',debit:'102',credit:'0',description:'Payroll labour costs'}]}}}],
});});
it('requires current payroll read permission before material access',async()=>{
  mock.permission.mockRejectedValue(new Error('denied'));
  await expect(getPayrollPostingPreview(ctx,'run')).rejects.toThrow('denied');expect(mock.material).not.toHaveBeenCalled();
});
it('projects the same exact plan without employee or bank input facts',async()=>{
  const result=await getPayrollPostingPreview(ctx,'run');
  expect(mock.permission).toHaveBeenCalledWith(ctx,'read:payroll');
  expect(result).toMatchObject({amount:'102',calculationVerified:true,lines:[{debit:'102',credit:'0'}]});
  expect(JSON.stringify(result)).not.toContain('secret');expect(result).not.toHaveProperty('observedSources');
});
it('propagates unverified calculation refusal without a made-up successful preview',async()=>{
  mock.material.mockRejectedValue(new Error('recalculate'));
  await expect(getPayrollPostingPreview(ctx,'run')).rejects.toThrow('recalculate');
});

it('reports execution blockers without pretending a verified calculation can post into a closed period',async()=>{
  const material=await mock.material();material.observedSources[0].facts.targetPeriod.status='closed';
  const result=await getPayrollPostingPreview(ctx,'run');expect(result.blockers).toContain('Fiscal period is not open');
});

const lockedPreview=async(lockdown_date:string|null,accountingDate:string)=>{
  const material=await mock.material();material.observedSources[0].facts.company={lockdown_enabled:true,lockdown_date};material.binding.accountingDate=accountingDate;
  return (await getPayrollPostingPreview(ctx,'run')).blockers;
};
it('blocks a run dated on or before a dated lockdown and clears the day after (shared lockdownBlock rule)',async()=>{
  expect(await lockedPreview('2026-09-30','2026-09-30')).toContain('Company accounting date is locked');
  expect(await lockedPreview('2026-09-30','2026-09-29')).toContain('Company accounting date is locked');
  expect(await lockedPreview('2026-09-30','2026-10-01')).not.toContain('Company accounting date is locked');
});
it('blocks every run date when lockdown is enabled with no date',async()=>{
  expect(await lockedPreview(null,'2099-12-31')).toContain('Company accounting date is locked');
});
