// Baseline-only dump. snapshotFlagBaseline.int.test.ts runs an identical copy of this file inside a worktree
// pinned to 45e4d3981 - before forked records were flagged - and compares what that source returned with HEAD.
import {it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import {ledgerSnapshotSources} from '@/modules/accounting/services/controls/auditSnapshotCaptureQueries';
import {actorAs,appendEntityVersion} from './intentReceiptRows';
it('dumps the baseline bank transaction snapshot rows for plain and forked entities',async()=>{
 const output=process.env.ISAFLOW_SNAPSHOT_DUMP_OUT;if(!output)throw new Error('ISAFLOW_SNAPSHOT_DUMP_OUT is required');
 const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
 try{
  const fixture=await provisionForensicFixture(config),user={id:fixture.u1.id,companyId:fixture.companyA},account=randomUUID();
  await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,$3,'Synthetic dump bank','asset','bank','debit',true,true,3)",[account,fixture.companyA,account.slice(0,12)]);
  const plain=[randomUUID(),randomUUID()],forked=[randomUUID()];
  for(const id of [...plain,...forked])await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',10,'Synthetic dump bank line','imported')",[id,fixture.companyA,account]);
  await appendEntityVersion(pool,user,'bank_transaction',plain[0]!,2);
  await appendEntityVersion(pool,user,'bank_transaction',forked[0]!,1);
  await appendEntityVersion(pool,user,'bank_transaction',forked[0]!.toUpperCase(),7);
  const source=ledgerSnapshotSources.find(row=>row.source==='bank_transaction')!;
  const rows=await actorAs(pool,user,ctx=>source.page(ctx,'2026-12-31',null));
  await writeFile(output,JSON.stringify({user,plain,forked,rows}),{mode:0o600});
 }finally{await pool.end();}
},120000);
