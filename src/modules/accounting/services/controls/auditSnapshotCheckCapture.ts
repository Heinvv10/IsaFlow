import type {ControlCheckResult,ControlTx} from './contracts';
import {canonicalJson} from './canonical';
import {AUDIT_JOB_LIMITS,type AuditSnapshotRequest} from './auditJobContract';
import {checkPayrollControls} from './payrollControlChecks';
import {checkDuplicateInvoices} from './duplicateInvoiceChecks';
import {checkPaymentRisks} from './paymentRiskChecks';
import {checkThreeWayMatchExceptions} from './threeWayMatchChecks';
import {checkJournalRisks} from './journalRiskChecks';
import {checkBankStatementCompleteness} from './bankStatementCompletenessChecks';
import type {AuditSnapshotData} from './auditSnapshotSeal';
const checkers={payroll_control_checks:checkPayrollControls,duplicate_invoice_checks:checkDuplicateInvoices,payment_risk_checks:checkPaymentRisks,
 three_way_match_exceptions:checkThreeWayMatchExceptions,journal_risk_checks:checkJournalRisks,bank_statement_completeness:checkBankStatementCompleteness};
function summary(result:ControlCheckResult){
 const {findings:_findings,nextCursor:_cursor,capturedAt:_capturedAt,...stable}=result;
 return canonicalJson(stable);
}
/** A detector page is never a complete retained check. Every page must describe the same population. */
export async function collectSnapshotCheckPages(load:(cursor?:string)=>Promise<ControlCheckResult>,budget:()=>void|Promise<void>):Promise<ControlCheckResult>{
 await budget();const first=await load();await budget();
 const expected=summary(first),findings=[...first.findings],keys=new Set(first.findings.map(f=>f.key)),cursors=new Set<string>();
 if(keys.size!==findings.length)throw new Error('Duplicate snapshot finding');
 if(first.findingCount>AUDIT_JOB_LIMITS.maxRecords)throw new Error('Snapshot check resource limit');
 let cursor=first.nextCursor;
 while(cursor){
  if(cursors.has(cursor))throw new Error('Repeated snapshot check cursor');cursors.add(cursor);await budget();
  const page=await load(cursor);await budget();
  if(summary(page)!==expected)throw new Error('Snapshot check population changed');
  for(const finding of page.findings){
   if(keys.has(finding.key))throw new Error('Duplicate snapshot finding');keys.add(finding.key);findings.push(finding);
  }
  if(!page.findings.length||findings.length>first.findingCount)throw new Error('Incomplete snapshot check pagination');
  cursor=page.nextCursor;
 }
 if(findings.length!==first.findingCount)throw new Error('Incomplete snapshot check findings');
 return{...first,findings,nextCursor:null};
}
export async function captureSnapshotChecks(ctx:ControlTx,request:AuditSnapshotRequest,budget:()=>void|Promise<void>):Promise<AuditSnapshotData['checks']>{
 const results:AuditSnapshotData['checks']=[];
 for(const checkId of request.checks){
  const check=await collectSnapshotCheckPages(cursor=>checkers[checkId](ctx,{cutoff:request.cutoff,limit:100,...(cursor?{cursor}:{})}),budget);
  results.push({...check,capturedAt:new Date(check.capturedAt).toISOString(),cutoff:request.cutoff,nextCursor:null,amountTotals:{...check.amountTotals},
   findings:check.findings.map(finding=>JSON.parse(canonicalJson(finding)) as Record<string,unknown>),coverage:[...check.coverage],
   missingSources:[...check.missingSources],sourceVersions:[...check.sourceVersions]});
 }
 return results;
}
