# K-016 — Bank allocation VAT code relieves the control account net

**Claim.** A VAT code on a supplier or customer allocation posts the control account net while
the payment document settles gross.

**Corrected trigger.** `allocateTransaction` with `allocType='supplier'` and `vatCode='standard'`
splits the line 15% exclusive (bankAllocationService.ts:148) and debits Accounts Payable with
`netAmount` (:242; the customer arm is :273/:283 against AR). The bank leg carries `totalAmount`
(:243) and the supplier payment document the same call creates carries `totalAmount` (:458), as
does the `customer_payments` row (:408). The bill already credited AP gross and claimed input tax at posting, so this relieves AP by R100
for R115 of cash, strands R15 on the control account, and claims input tax twice. The `account`
arm at :290 is the case the net split is legitimately for.

**Disposition: confirmed.**

**Evidence.** File unchanged 5661d6f0..ebeac9ca. RED integration test, real PostgreSQL: R115 out,
bank credited 115, `supplier_payments.total_amount` 115, AP debited **100**, VAT input debited 15.

**Reachability.** `pages/api/accounting/bank-transactions-action.ts:118` passes `body.vatCode`
straight through with `allocationType`, no coercion — `resolveRuleVatCode` only guards
`allocType === 'account'` (ruleVatResolution.ts:57). Also reachable from
`src/lib/mcp/tools/allocationLine.ts:270`.

**RED test.** `tests/integration/k016-bank-allocation-vat-net-control-account.int.test.ts` —
1 failed / 1. Log: `docs/audits/remediation/K-016/red.log`.

**Proposed minimal fix.** In the `supplier` and `customer` arms only, ignore the VAT split: use
`totalAmount` on the AP/AR leg and emit no VAT line. A settlement of an existing invoice carries no
supply. Simplest shape: compute `hasVat` as `effectiveVatCode === 'standard' && allocType === 'account'`
and leave the four branches alone. Do the same in K-017's builder so both paths agree.

**Historical-data impact.** Every allocation posted with a VAT code against a supplier or customer
leaves the VAT portion stuck on the control account and double-claims input tax. Read-only:
```sql
SELECT je.company_id, je.id, je.entry_date, je.source, sum(jl.debit + jl.credit) AS total
  FROM gl_journal_entries je
  JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
  JOIN gl_accounts a ON a.id = jl.gl_account_id
 WHERE je.source IN ('auto_supplier_payment', 'auto_payment')
   AND a.account_subtype IN ('vat_input', 'vat_output')
 GROUP BY 1,2,3,4;
```
Each row returned is a settlement journal carrying a VAT leg it should not have.

**Risks.** Affects new journals only; correcting existing entries is a separate decision.
