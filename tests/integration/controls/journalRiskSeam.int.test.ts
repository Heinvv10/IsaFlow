import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {checkJournalRisks} from '@/modules/accounting/services/controls/journalRiskChecks';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import {checkJournalRisks as referenceCheckJournalRisks} from './journalRiskSeamReference/journalRiskChecks';
import {CUTOFF,seedJournalRiskPopulation} from './journalRiskCheckRunFixture';
/**
 * Plan v6 A15 gate c0. `journalRiskSeamReference/` is the detector exactly as it stood at bcf5aab53, before T2c gave
 * it the population-SQL builder, the defaulted source-limit seam and the shared pure functions, and before the blind
 * review extracted its group-eligibility predicate and removed the quadratic copy (its header records the blobs).
 * Both run on one live fixture, in one transaction, under one frozen clock, and every page must be byte-identical —
 * including `nextCursor`, whose signature embeds `sourceHash`, and every `sourceVersions` fingerprint. So the shared
 * layer the A20 differential cannot see (plan v8 A33) is proven unchanged, not argued.
 */
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:3});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);await seedJournalRiskPopulation(pool,fixture);},180000);
afterAll(()=>pool.end());
afterEach(()=>{vi.useRealTimers();});
it('today\'s detector is byte-identical to the pre-seam reference on every page, cursor and fingerprint',async()=>{
 vi.useFakeTimers({toFake:['Date'],now:new Date('2026-09-10T10:00:00.000Z')});
 const who={companyId:fixture.companyA,personId:fixture.u1.id};
 const pages=await withAuditWorkerTransaction(pool,{...who,jobId:randomUUID()},'repeatable read',Date.now()+120000,undefined,
  store=>withControlRequest(store,{...who,authMethod:'cookie'},async()=>{
   const ctx=requireControlTx(),compared:Array<{reference:string;current:string}>=[];let cursor:string|undefined;
   do{
    const options={cutoff:CUTOFF,limit:100,...(cursor?{cursor}:{})};
    const reference=await referenceCheckJournalRisks(ctx,options),current=await checkJournalRisks(ctx,options);
    compared.push({reference:canonicalJson(reference),current:canonicalJson(current)});
    // The reference's cursor drives both: a current detector with a different sourceHash would refuse it.
    cursor=reference.nextCursor??undefined;
   }while(cursor);
   return compared;
  }));
 expect(pages.length,'the fixture did not span a page boundary, so no cursor was compared').toBeGreaterThanOrEqual(2);
 pages.forEach((page,index)=>expect(page.current,`page ${index} differs from the pre-seam reference`).toBe(page.reference));
 const first=JSON.parse(pages[0]!.reference) as {findingCount:number;sourceVersions:unknown[];nextCursor:string|null};
 expect(first.nextCursor).not.toBeNull();expect(first.findingCount).toBeGreaterThan(100);expect(first.sourceVersions.length).toBeGreaterThan(0);
},180000);
