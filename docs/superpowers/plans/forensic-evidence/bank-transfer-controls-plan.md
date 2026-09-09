# Shared bank transfer restoration

Base dcac22d29; isolated root transfer worktree. Root owns plan/request contract, shared prepare/material/effect/original/reversal/REST/MCP/import/relink dispatch. Exception worker owns new transfer source and candidate helpers on same named base; snapshot owns dimension changes to existing Sources/Effect, to be integrated before root edits those seams. No migration allocated.

## Contract and behavior

External transfer request: version1, kindtransfer, bankTransactionId, counterpartyAccountId, optional description. Never accept amount, selected opposite, original journal, authority or fingerprint from caller. Server saves transfer mode post with exact oppositeBankTransactionId or null; mode link saves originalIntentId for an existing controlled bank-bound journal. Both use existing bank_allocation.post approval operation with immutable saved plan/current source binding. Caller cannot switch mode at execution.

Post mode creates exactly two signed bank GL legs, no VAT/payment/application children. Exact cent amount comes from owned source. Owned active different bank accounts and unambiguous ZAR metadata required. Deterministic opposite candidate within inclusive two days, exact opposite cents; selected IDs saved before approval. Current permissions, company policy and unordered bank pair lock precede deterministic row locks and source recheck. Concurrent opposite attempts cannot post a second journal. Receipt includes exact journal/linked bank identities.

Link mode changes only the exact newly imported bank row to the original journal leg, requires current approval binding and immutable original bank intent/effect/change evidence, and checks that leg remains unused. Original journal is not reposted. Imports/background relink may prepare this controlled operation, but cannot execute without shared policy approval. Existing legacy/standalone journals do not become verified bank-bound evidence merely by similar amounts. Economic duplicates without valid provenance must be explicit unresolved/refusal.

Reversal from either linked feed resolves the same original intent. Exact original two-leg economics and approved link receipts determine affected rows; never fresh-search on inverse. One approved contra, both links cleared atomically, own change events, no payment child unwinds. Retry checks current authority and actual retained effect state. A valid later controlled link must not silently invalidate original post receipt; original post material excludes unselected candidate discovery after posting while linking has its own binding/evidence.

## File work and failing scenarios

1. Root bankAllocationTransferPlan.ts + bankAllocationPlan.ts: strict caller request vs saved selection, both signs, exact huge cents, fractional/zero rejection, no VAT/dimensions/same-account. Unit tests first.
2. Worker bankAllocationTransferSources.ts/helpers/tests: exact owned candidate selection, currency/activity/population bounds, dates/ties, named provenance, raw extra/foreign/missing journal legs, current context/permission, deterministic locks. Real PostgreSQL proof.
3. Root bankAllocationControl/Material and existing Sources/Effect after dimensions integrate: derive immutable selection, stable discovery vs posted material, real journal/link effects and exact receipt. Actual PostgreSQL RED for transfer refusal before restoring behavior; concurrent opposite attempts, stale candidate/material, revocation, source changes, failure rollback, retry.
4. Root ReversalSources/Effect/Material, bankControlReadProvenance and shared GL relationships: either-bank original identity, late controlled link, one contra and atomic clearing, tamper/refused raw inverse, no fresh inverse search.
5. Root bankAllocationService, bankTransferAutoLink/LinkService/LinkPasses, import/relink callers, API/MCP and snapshot-owned UI: every legacy entry delegates shared preparation/execution; actual import/job/REST/MCP paths cannot mutate allocation without the same controls. No temporary explicit refusal presented as final restored capability.
6. Independent named reviews and focused/realPG tests for each source slice, integrated transfer HTTP/browser workflow; final full programme CI remains mandatory before draft PR.
