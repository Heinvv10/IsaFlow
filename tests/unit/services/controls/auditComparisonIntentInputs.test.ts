import {beforeEach,it,expect,vi} from 'vitest';
const read=vi.hoisted(()=>vi.fn());
vi.mock('@/modules/accounting/services/controls/auditSnapshotIntentMetadata',()=>({readAuditSnapshotIntentMetadata:read}));
import {readComparisonIntentInputs} from '@/modules/accounting/services/controls/auditComparisonIntentInputs';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const a={snapshotId:first,sourceJobId:first,sourceRequestHash:'a'.repeat(64),permissions:['read:payroll','read:reports']};
const b={snapshotId:second,sourceJobId:second,sourceRequestHash:'b'.repeat(64),permissions:['read:reports']};
const ctx={} as ControlTx;
const request={requestVersion:2 as const,sourceVerification:'worker' as const,comparisonRuleVersion:1 as const,firstSnapshotId:first,secondSnapshotId:second,idempotencyKey:'one',
 permissions:['read:payroll','read:reports'] as ('read:payroll'|'read:reports')[],firstSource:{snapshotId:first,sourceJobId:first,sourceRequestHash:a.sourceRequestHash},secondSource:{snapshotId:second,sourceJobId:second,sourceRequestHash:b.sourceRequestHash}};
beforeEach(()=>{read.mockReset();read.mockResolvedValueOnce(a).mockResolvedValueOnce(b);});
it('checks both authenticated original intents and preserves their exact ordered anchors',async()=>{
 expect(await readComparisonIntentInputs(ctx,request)).toEqual({first:a,second:b});expect(read.mock.calls).toEqual([[ctx,first],[ctx,second]]);
});
it('refuses changed source request anchors and missing current union permissions',async()=>{
 await expect(readComparisonIntentInputs(ctx,{...request,secondSource:{...request.secondSource,sourceRequestHash:'c'.repeat(64)}})).rejects.toThrow(/anchor/i);
 read.mockResolvedValueOnce(a).mockResolvedValueOnce(b);
 await expect(readComparisonIntentInputs(ctx,{...request,permissions:['read:reports']})).rejects.toThrow(/permission/i);
});
it('preserves current reader refusals instead of treating an old anchor as authority',async()=>{
 read.mockReset();read.mockResolvedValueOnce(a).mockRejectedValueOnce(new Error('Revoked second source'));
 await expect(readComparisonIntentInputs(ctx,request)).rejects.toThrow('Revoked second source');
});
