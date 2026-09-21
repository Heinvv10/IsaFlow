# K-132 — missing Netcash keys make a payment run report success

**Claim.** `netcashService.ts:58` short-circuits on absent credentials to a success
result instead of an error.

**Corrected trigger.** `submitEftBatch` returns
`{ success: true, batchReference: 'MOCK-<Date.now()>', mock: true }` when either key is
falsy; `getSubmissionStatus` returns `{ status: 'processing', mock: true }` on the same
condition. `pages/api/accounting/netcash/submit.ts` reads the credentials as
`String(company.netcash_service_key ?? '')`, so a company with `netcash_enabled = true`
and NULL keys reaches the mock path. The route then writes a `netcash_submissions` row
with `status = 'submitted'` and `submitted_at = NOW()` carrying the fabricated
reference, and answers 200. The operator is told the payment run went out. No money
moved. The `mock: true` flag is optional on the type and advisory in the response —
nothing forces a caller to branch on it, and the persisted row does not.

`ap/.claude.md:33` already records the rule this violates: "production must not gate on
absence".

**Disposition: confirmed.**

**Evidence.**
- `git show origin/master:src/modules/accounting/services/ap/netcashService.ts:53-63,
  108-113`; `pages/api/accounting/netcash/submit.ts:18-40, 84-115`.
- Executed RED test, 2 of 2 failing: `submitEftBatch('','',[…])` →
  `success: true, batchReference: 'MOCK-…'`; `getSubmissionStatus('','…')` →
  `status: 'processing'`.

**Reachability.** Any tenant that toggles Netcash on in Company Settings before saving
keys. No further precondition. The status poller then never reaches a terminal state,
so the submission sits "processing" forever.

**RED test.** `tests/unit/k132-netcash-missing-keys-report-success.test.ts`
(2 tests, 2 failed) — output in `red.log`. Pure logic, no database.

**Proposed minimal fix.** Return `{ success: false, error: 'Netcash credentials are not
configured' }` from `submitEftBatch` and a distinct non-`processing` status (e.g.
`{ status: 'unknown', detail: … }`) from `getSubmissionStatus` when a key is absent.
Keep the mock only behind an explicit opt-in env flag if a sandbox path is still wanted;
do not infer sandbox from a missing secret. Preferably also make the route refuse before
calling, since it already loads the credentials.

**Historical-data impact.** Payment runs believed sent that never left. Read-only impact
query (NOT run — production out of scope):

```sql
SELECT company_id, COUNT(*), SUM(total_amount_cents)/100.0 AS rands
FROM netcash_submissions
WHERE status = 'submitted' AND batch_reference LIKE 'MOCK-%'
GROUP BY company_id;
```

Any hit means suppliers were not paid while the system says they were, and the
matching `supplier_payment_batches` may have been processed into the GL.

**Risks.** A tenant relying on the mock for demo purposes starts getting errors. That is
the intended outcome.
