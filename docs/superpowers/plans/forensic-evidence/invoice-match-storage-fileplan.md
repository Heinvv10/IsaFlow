# Invoice match override stored evidence correction

Base: be38beb38. Owner: invoice_evidence. Source ownership: invoiceMatchOverrideMaterial.ts only.

Confirmed gap: verifyInvoiceMatchEvidence still queries raw_bytes, removed by migration411. Existing database fixtures hid the production-schema failure. Replace that predicate with same-company same-invoice association followed by the central actual storage reader and verified recorded hash. Detach refs before awaiting and share one operation deadline; authority and SQL failures must propagate unchanged.

Tests first: focused actual-reader admission, absent/unverified bytes, caller mutation/accessor refusal and authority failure after deadline. Dedicated PostgreSQL test transactionally drops raw_bytes and verifies actual local HTTP bytes; unchanged metadata with changed remote bytes must fail. Existing override lifecycle tests will run using the separately owned storage fixture migration. No migration or transport changes.

Acceptance: focused RED then GREEN, real PostgreSQL and HTTP schema411 proof, source type-check, scoped lint, independent named commit review before integration. Database and heavy checks require root's serialized lease.
