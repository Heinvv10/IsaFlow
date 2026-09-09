import {randomUUID} from 'node:crypto';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import type {ControlTx} from './contracts';
import {parseBankStatementAttestation} from './bankStatementAttestationInput';
import {loadBankStatementSource,withStatementSourceLocks} from './bankStatementAttestationSource';
import {recordCommittedChange} from './changeEventService';
export async function prepareBankStatementAttestation(ctx:ControlTx,input:unknown){
 await assertEffectivePermission(ctx,'write:bank-tx');const parsed=parseBankStatementAttestation(input);
 return withStatementSourceLocks(ctx,async()=>{
  const source=await loadBankStatementSource(ctx,parsed.bankAccountId,parsed.sourceDocumentId,parsed.expectedSourceHash);
  if(source.currency!==parsed.currency)throw new Error('Statement currency must match current ledger currency');
  const id=randomUUID();
  await ctx.sql`INSERT INTO control_bank_statement_attestation_intents(company_id,id,requester_person_id,bank_account_id,source_document_id,
   expected_source_hash,source_fingerprint,period_start,period_end,source_count,opening_balance,closing_balance,currency)
   VALUES(${ctx.principal.companyId}::uuid,${id}::uuid,${ctx.principal.personId},${parsed.bankAccountId}::uuid,${parsed.sourceDocumentId}::uuid,
    ${parsed.expectedSourceHash},${source.fingerprint},${parsed.periodStart}::date,${parsed.periodEnd}::date,${parsed.sourceCount},
    ${parsed.openingBalance}::numeric,${parsed.closingBalance}::numeric,${parsed.currency})`;
  await recordCommittedChange(ctx,{entityType:'bank_statement_attestation_intent',entityId:id,previousVersion:null,newVersion:1,
   action:'bank_statement.attestation_prepared',accountingDate:parsed.periodEnd,before:null,after:{...parsed,sourceFingerprint:source.fingerprint},bindingHash:null,protectedEvidenceRef:null});
  return{intentId:id,operation:{entityType:'bank_statement_attestation_intent',entityId:id,operation:'bank_statement.attest' as const}};
 });
}
