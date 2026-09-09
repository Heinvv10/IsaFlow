# Invoice match override stored evidence correction

Base: be38beb38. Owner: invoice_evidence. Source ownership: invoiceMatchOverrideMaterial.ts only.

Confirmed gap: verifyInvoiceMatchEvidence still queries raw_bytes, removed by migration411. Existing database fixtures hid the production-schema failure. Replace that predicate with same-company same-invoice association followed by the central actual storage reader and verified recorded hash. Detach refs before awaiting and share one operation deadline; authority and SQL failures must propagate unchanged.

Tests first: focused actual-reader admission, absent/unverified bytes, caller mutation/accessor refusal and authority failure after deadline. Dedicated PostgreSQL test transactionally drops raw_bytes and verifies actual local HTTP bytes; unchanged metadata with changed remote bytes must fail. Existing override lifecycle tests will run using the separately owned storage fixture migration. No migration or transport changes.

Acceptance: focused RED then GREEN, real PostgreSQL and HTTP schema411 proof, source type-check, scoped lint, independent named commit review before integration. Database and heavy checks require root's serialized lease.

## Verification checkpoint

- Tests: b829288a2 and c6345056f. Six focused unit failures recorded before implementation (`invoice-match-storage-unit-expanded-red.log`).
- Dependency: author fixture089aaa71f imported as bd37c155d; plan-file add/delete resolution retained incoming named document. This is test-only, separately reviewed by its owner.
- Source correction: f5b76b6c7. Actual PostgreSQL RED reproduced with exact c6345056f source temporarily restored in this owned worktree, two42703 failures (`invoice-match-storage-pg-red.log`), then exact corrected source restored.
- Six focused unit tests GREEN; actual PostgreSQL plus local HTTP suite and existing migrated approval lifecycle:14 GREEN, session60738 terminal0 (`invoice-match-storage-pg-green.log`). Database lease released.
- Deadline is one20s signal for the complete max20-reference verification batch, propagated to actual object reads. It does not claim cancellation of arbitrary SQL or a global deadline across every repeated materialization in an outer approval request; caller/runner deadlines remain central programme work.
- Source type-check and scoped lint running69285 at this checkpoint. Independent named source/test review and integration remain root-owned acceptance steps. No production or transport verification claimed.
