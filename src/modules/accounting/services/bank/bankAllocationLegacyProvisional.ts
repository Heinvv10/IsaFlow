/**
 * Reversing a provisional bank entry that PREDATES the controlled bank allocation.
 *
 * Production holds provisional journals posted by the old unattended path: no allocation intent, no receipt, nothing
 * for a controlled reversal to name as the original — and a direct reverse of one is refused, because the journal
 * carries a generated source. Dismiss and undo were therefore impossible for every such entry.
 *
 * This proves the original from the DATA instead, and the proof is the whole authority for the reversal:
 *   - exactly one bank transaction in the company names the journal as its provisional entry and is still provisional;
 *   - the journal is a posted, unreversed 'auto_bank_recon' journal for that company;
 *   - it carries exactly ONE line on that bank account, crediting the statement amount (an outflow — the only shape
 *     the provisional poster ever wrote), and its debits equal that amount;
 *   - nothing hangs off it: no payment, and therefore no invoice application to walk back.
 * A journal failing any of those is refused, never reversed — the whole point is that we cannot ask a receipt.
 *
 * The reversal itself is the SAME controlled operation (`bank_allocation.reverse`) under the same approval policy as
 * a reversal with a receipt; only the provenance differs, and the intent records which journal was proven.
 */
import Decimal from 'decimal.js';
const D=Decimal.clone({precision:80});
import {assertControlTx} from '../controls/context';
import type {ControlTx} from '../controls/contracts';
type Row=Record<string,unknown>;
export interface LegacyProvisionalOriginal {journal:Row;lines:Row[];bank:Row;bankLine:Row}
/** Every read locks what it proves, so the proof cannot go stale between here and the write. */
export async function loadLegacyProvisionalOriginal(ctx:ControlTx,journalEntryId:string):Promise<LegacyProvisionalOriginal>{
 assertControlTx(ctx);const company=ctx.principal.companyId;
 const [journal]=await ctx.sql`SELECT id,entry_date::text AS entry_date,status,source,reversed_at,needs_evidence,source_record_id
  FROM gl_journal_entries WHERE company_id=${company}::uuid AND id=${journalEntryId}::uuid FOR SHARE` as Row[];
 if(!journal||journal.status!=='posted'||journal.reversed_at||journal.source!=='auto_bank_recon'){
  throw new Error('Provisional journal provenance cannot be proven');
 }
 const banks=await ctx.sql`SELECT * FROM bank_transactions WHERE company_id=${company}::uuid
  AND provisional_je_id=${journalEntryId}::uuid FOR UPDATE` as Row[];
 if(banks.length!==1||banks[0]!.status!=='provisional')throw new Error('Provisional journal provenance cannot be proven');
 const bank=banks[0]!,amount=new D(String(bank.amount));
 if(!amount.lt(0))throw new Error('Provisional journal provenance cannot be proven');
 const lines=await ctx.sql`SELECT id,gl_account_id,debit::text AS debit,credit::text AS credit,vat_type,cost_center_id,cc1_id,cc2_id,bu_id
  FROM gl_journal_lines WHERE company_id=${company}::uuid AND journal_entry_id=${journalEntryId}::uuid ORDER BY id FOR SHARE` as Row[];
 const bankLines=lines.filter(line=>line.gl_account_id===bank.bank_account_id);
 const gross=amount.abs();
 if(bankLines.length!==1||!new D(String(bankLines[0]!.credit)).eq(gross)||!new D(String(bankLines[0]!.debit)).isZero()
  ||!lines.reduce((sum,line)=>sum.add(String(line.debit)),new D(0)).eq(gross)){
  throw new Error('Provisional journal provenance cannot be proven');
 }
 const children=await ctx.sql`SELECT id FROM customer_payments WHERE company_id=${company}::uuid AND gl_journal_entry_id=${journalEntryId}::uuid
  UNION ALL SELECT id FROM supplier_payments WHERE company_id=${company}::uuid AND gl_journal_entry_id=${journalEntryId}::uuid` as Row[];
 if(children.length)throw new Error('Provisional journal provenance cannot be proven');
 return{journal,lines,bank,bankLine:bankLines[0]!};
}
/**
 * Whether a contra is the mirror of the proven journal, line for line.
 *
 * NOT `matchesBankAllocationJournalLines`: that one also demands cost_center_id = cc1_id, which the controlled writer
 * maintains and the OLD provisional poster did not (it wrote a predicted cost_center_id with cc1_id null). Holding a
 * legacy contra to the new writer's convention would refuse exactly the entries this path exists to reverse, so the
 * comparison is against what the original actually carries — every account, amount, VAT classification and dimension
 * mirrored, and nothing else admitted.
 */
export function isLegacyProvisionalContra(original:LegacyProvisionalOriginal,contra:readonly Row[]):boolean{
 if(contra.length!==original.lines.length)return false;
 const money=(value:unknown)=>new D(String(value)).toFixed();
 const key=(account:unknown,debit:unknown,credit:unknown,vat:unknown,cc:unknown,cc1:unknown,cc2:unknown,bu:unknown)=>
  JSON.stringify([String(account),money(debit),money(credit),vat??null,cc??null,cc1??null,cc2??null,bu??null]);
 const mirrored=original.lines.map(line=>key(line.gl_account_id,line.credit,line.debit,line.vat_type,line.cost_center_id,line.cc1_id,line.cc2_id,line.bu_id)).sort();
 const stored=contra.map(line=>key(line.gl_account_id,line.debit,line.credit,line.vat_type,line.cost_center_id,line.cc1_id,line.cc2_id,line.bu_id)).sort();
 return mirrored.every((line,index)=>line===stored[index]);
}
