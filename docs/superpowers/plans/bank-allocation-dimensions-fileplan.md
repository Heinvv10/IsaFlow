# Bank dimensions compatibility

Owner snapshot_capture; root assigned bankAllocationSources/Effect plus new dimension helper, transport preparation mappings, and exact shared GL reverse copy/material fields. Isolated commit slice before UI integration; no migrations.

## Validated source gap

At5661d6f0 bankAllocationService315-317 applied cc1 via costCenterId and buId to nonbank legs. cc2 was stored on bank metadata393 but not posted as journal dimension. Current11dd plan accepts cc1/cc2/bu on account/split lines, yet loadSources32 rejects every selected dimension. Effect writes cost_center_id and bu_id, omits cc1/cc2. Shared reverseJournalEntry84-86 also omits cc1/cc2; glOperationMaterializer45 does not observe them.

## Changes and acceptance

Validate actual owned cost_centres cc_type/is_active and business_units is_active before preparation. Bind relevant selected dimension classification and current facts into existing source fingerprint only for dimensioned plans; absent dimensions preserve old field shape. Post explicit cost_center_id+cc1_id, cc2_id and bu_id on intended lines. Shared inverse preserves all existing columns plus cc1/cc2. Shared GL material includes cc1/cc2 only when non-null; existing non-null previously unobserved material invalidates old approval, never rewrites receipts.

Actual tests first: direct preparation refusal, exact dimension posting/inverse, wrong-kind/inactive/foreign dimension, changed selected dimension before execution, journal dimension tamper after posting, nonbank GL inverse preservation, dimension-free fingerprint shape unchanged. Root approval for party optional dimension fields pending; baseline party nonbank dimensions must not be silently omitted.

Real PostgreSQL/source TS serialized by root leases. No production verification or full UI claim.
