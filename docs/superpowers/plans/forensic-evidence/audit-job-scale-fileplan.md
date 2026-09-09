# Actual isolated audit scale calibration

Exact base16eef4d34, branch feat/mcp-audit-scale-20260910. Worker owns only auditJobScale.int.test.ts, auditJobScaleFixture.ts, and this file. Root owns production sources/contracts and resource grants.

Read committed programme/progress and capture/export fileplans: retained canonical data and aggregate evidence each100MiB; records100000; worker60s, parent65s+2s, cgroup8GiB/swap0. Export1GiB is an outer ceiling, not evidence that1GiB retained inputs are admitted. Existing snapshot100001-row fixture needed expensive cleanup; new scale fixture uses a fresh synthetic tenant and bounded insert batches, no global trigger suppression or production data.

Tests FIRST: actual snapshot must succeed for the admitted population; independent SQL counts/totals/identity digest must match journal_entry plus journal_line projection exactly. Actual export must succeed, status reads must leave queued attempts0, every retained export file/chunk must authenticate and reconstruct, canonical snapshot and signed manifest must match independent source population. Idempotent retry must not republish. Record actual elapsed, cgroup charged peak and sampled RSS separately, plus actual emitted bytes. Failures remain capability evidence; never reduce admitted records to hide them.

Calibration only1000records (250 balanced synthetic draft headers, each3lines: debit1+2,credit3). Draft status is intentional capture population, not a claim of exercising production posting. Source counts must verify this projection. Later100000records needs separate explicit lease/environment guard. No evidence nearbound or8GiB pressure run authorized yet. Test streams export chunks to private temporary files and hashes incrementally; only the independently100MiB-bounded canonical snapshot/manifest is loaded for comparison. No nearGiB concatenation.

Current state: test source authored before fixture helper, execution pending root PG grant; root owns current build/heavy slot. No RED/GREEN claimed yet. Actual worker artifact must come from the exact trusted build, explicit local fixture config only. No source changes or migration required for the test plan.
