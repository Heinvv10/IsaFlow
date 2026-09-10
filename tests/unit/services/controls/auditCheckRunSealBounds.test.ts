import {beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {analyseJournalRisks,type JournalRiskRow,type JournalThreshold} from '@/modules/accounting/services/controls/journalRiskAnalysis';
import {buildJournalRiskFinding,type JournalRiskSourceRow} from '@/modules/accounting/services/controls/journalRiskShared';
import {CHECK_RUN_ITEM_BOUNDS,sealAuditCheckRunItem} from '@/modules/accounting/services/controls/auditCheckRunProtection';
beforeAll(()=>{process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');});
const identity={companyId:randomUUID(),checkRunId:randomUUID(),generation:1,leaseId:randomUUID()};
/**
 * The seal must never refuse a finding the synchronous detector accepts. The detector's message is bounded by its
 * inputs at their DATABASE type bounds: at most 100 usable thresholds (it keeps 100), ids that are uuid (36 chars),
 * versions that are bigint (at most 19 digits), and six fixed per-row signals. This builds that worst case through
 * the real detector and the real finding builder — no hand-written message — and seals it.
 */
function worstCase(){
 const thresholds:JournalThreshold[]=Array.from({length:100},(_unused,index)=>({id:`ffffffff-ffff-4fff-bfff-${String(index).padStart(12,'f')}`,
  version:Number.MAX_SAFE_INTEGER,amount:'1.5',operator:'greater_than'}));
 // node-pg returns a bigint column as a STRING, so the detector interpolates all 19 digits of the widest value
 // `control_version` can hold; the declared `number` type is narrower than what actually arrives.
 for(const threshold of thresholds)(threshold as unknown as {version:string}).version='9223372036854775807';
 const row=(id:string):JournalRiskSourceRow&JournalRiskRow=>({id,accountingDate:'2026-06-05',actualAt:'2026-06-06T20:00:00+02:00',actualBasis:'posted_at',
  personId:'p',amount:'1',currency:'ZAR',reversalOfId:randomUUID(),reversedAt:null,periodState:'closed',periodEventId:randomUUID(),version:1,
  changes:[{id:randomUUID(),action:'journal.amended',periodState:'locked',periodEventId:randomUUID()}],lineCount:1,changeCount:1,reversalOwned:true,periodEventVersion:1});
 const results=analyseJournalRisks([row(randomUUID()),row(randomUUID())],thresholds);
 expect(results[0]!.reasons,'the worst case did not trigger every signal and every threshold').toHaveLength(106);
 return buildJournalRiskFinding(results[0]!);
}
it('seals the longest message the detector can produce, and states that bound',()=>{
 const built=worstCase();
 expect(built.finding.message.length,'the detector can exceed the declared message bound').toBeLessThanOrEqual(CHECK_RUN_ITEM_BOUNDS.message);
 expect(()=>sealAuditCheckRunItem(identity,0,{amount:built.amount,currency:built.currency,finding:built.finding})).not.toThrow();
});
it('seals any company currency and any canonical amount the synchronous path would carry',()=>{
 const built=worstCase();
 // companies.default_currency is unbounded text; canonical money allows 30 integer and 12 fraction digits.
 const currency='X'.repeat(CHECK_RUN_ITEM_BOUNDS.currency),amount=`-${'9'.repeat(30)}.${'9'.repeat(12)}`;
 expect(()=>sealAuditCheckRunItem(identity,0,{amount,currency,finding:built.finding})).not.toThrow();
 expect(CHECK_RUN_ITEM_BOUNDS.currency,'a currency code sync would accept can be refused by the seal').toBeGreaterThanOrEqual(1024);
});
