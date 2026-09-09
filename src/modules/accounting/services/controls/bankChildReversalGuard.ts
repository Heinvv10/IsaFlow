import type {ControlTx} from './contracts';
import {assertControlTx} from './context';
/** A bank receipt/payment is reversed with its bank parent so both ledgers and allocation agree. */
export async function assertStandaloneBankChildReversal(ctx:ControlTx,paymentId:string,journalId:unknown):Promise<void>{
 assertControlTx(ctx);
 const [origin]=await ctx.sql`SELECT 1 AS bank_owned WHERE EXISTS(
  SELECT 1 FROM control_operation_effects e
  WHERE e.company_id=${ctx.principal.companyId}::uuid AND e.operation='bank_allocation.post'
   AND e.entity_type='bank_allocation_intent' AND e.result->>'paymentId'=${paymentId}
 ) OR EXISTS(
  SELECT 1 FROM bank_transactions b JOIN gl_journal_lines l
   ON l.company_id=b.company_id AND l.id=b.matched_journal_line_id
  WHERE b.company_id=${ctx.principal.companyId}::uuid AND l.journal_entry_id=${journalId??null}::uuid
 )`;
 if(origin)throw new Error('Bank-created payment requires its bank allocation reversal');
}
