# Bank dimensions compatibility

Owner snapshot_capture; root assigned bankAllocationSources/Effect plus new dimension helper, transport preparation mappings, and exact shared GL reverse copy/material fields. Isolated commit slice before UI integration; no migrations.

## Validated source gap

At5661d6f0 bankAllocationService315-317 applied cc1 via costCenterId and buId to nonbank legs. cc2 was stored on bank metadata393 but not posted as journal dimension. Current11dd plan accepts cc1/cc2/bu on account/split lines, yet loadSources32 rejects every selected dimension. Effect writes cost_center_id and bu_id, omits cc1/cc2. Shared reverseJournalEntry84-86 also omits cc1/cc2; glOperationMaterializer45 does not observe them.

## Changes and acceptance

Validate actual owned cost_centres cc_type/is_active and business_units is_active before preparation. Bind relevant selected dimension classification and current facts into existing source fingerprint only for dimensioned plans; absent dimensions preserve old field shape. Post explicit cost_center_id+cc1_id, cc2_id and bu_id on intended lines. Shared inverse preserves all existing columns plus cc1/cc2. Shared GL material includes cc1/cc2 only when non-null; existing non-null previously unobserved material invalidates old approval, never rewrites receipts.

Actual tests first: direct preparation refusal, exact dimension posting/inverse, wrong-kind/inactive/foreign dimension, changed selected dimension before execution, journal dimension tamper after posting, nonbank GL inverse preservation, dimension-free fingerprint shape unchanged. Root approved party optional dimensions and supplied c3b181d2d/a46aa1710, cherry-picked as84fee1526/3d2da9da9. Party dimensions belong only on nonbank control legs, including refunds.

Real PostgreSQL/source TS serialized by root leases. No production verification or full UI claim.

## Verification checkpoint 2026-09-10

Initial actual50949 preparation RED preceded shared dimension implementation. Actual97167 then exposed omitted inverse cc1/cc2 and missing CC2 receipt observation; stale test SQL concatenation fixture error was corrected separately. After shared copy/material corrections, session23838 terminal1 passed all8 dimension PG cases and3 prior reviewer cases; sole failure was separate missing bankAmount response RED. The eight cover account bank inverse, nonbank inverse, selected-dimension stale refusal, foreign/inactive/wrong-type, posted CC2 tamper, unchanged absent-key material, party refund HTTP and per-line split HTTP.

Source TS66722 found map inference losing Row index fields; explicit mapped Row type fixed it, TS65392 terminal0. Legacy allocateTransaction party branch still omits supplied dimensions; root authorized propagation, new actual isolated fixture regression written before fix and awaiting PG RED. No independent review or integrated dimension capability claim yet. Next: adapter RED/fix, final9PG/TS/lint, isolated dimension commit and root review.

Legacy adapter actual4150 RED persisted a posted customer refund intent without all three supplied dimension IDs. That run also exposed a duplicate fixture pool.end from a nested fixture; corrected to reuse this suite's private tenant fixture (its approval rules removed only for the last no-independent-policy adapter case). Added exact three-field propagation to existing party adapter; actor/reference behavior unchanged. Final71681 terminal0: all9 dimension PG plus4 reviewer PG; pools and HTTP servers closed. Final source TS99963 and scoped backend ESLint13509 terminal0. Ready for independent named review; UI source remains separate and browser acceptance outstanding.

## Independent review correction

Root review of dc6cf2294 confirmed a candidate: cost_center_id could change while cc1_id stayed unchanged, yet inverse and reader shape checks omitted legacy cost center. Actual80440 reproduced both REDs after approved posting: inverse preparation returned an intent and reader returned verified original despite private cost-center-only tamper. Both mutations rolled back. Added cost_center_id to all five actual shape-query callers and require stored legacy cost center equal the independently matched planned cc1. No persisted fingerprint shape change for all-null dimensions.

Pure changed-cost-center test RED ee5131 →9unit GREEN f92e9d. Final66214 terminal0:11 dimension PG and4 reviewer PG all passed; actual pool/server closure confirmed. TS5416 and scoped lint1658 both terminal0. Root must independently review this correction before integration; prior findings are not closed solely by author tests.
