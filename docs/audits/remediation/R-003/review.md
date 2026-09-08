# R-003 independent review

Initial named review of 6ed297f1 against ff2ab7ba found two concerns: signed outbound status callbacks could activate the recipient number, and percent-encoded token URLs could escape logging redaction. Both now have recorded failing regressions (provenance-red.log and logging-red.log).

The followup restricts activation/ingestion to documented signed inbound WhatsApp fields, matching sender identity, and no outbound status values. Token query redaction now handles encoded names and entire encoded values before logging. Shared transaction locks, post-lock proof/expiry rereads, pending-vs-active separation and scoped ingestion were accepted in initial review. The reviewer agreed the inbound event gate resolves the documented outbound callback distinction without requiring a provider API lookup, subject to trusted account/key administrators and separate sandbox acceptance.

The previously oversized inbound unit-test file was split into shared fixtures, media tests and query-reply tests, each below300 lines. Existing assertions remain; missing-binding rejection is covered. Current checks:18 PostgreSQL ownership cases,8 routing/migration cases,344 unit cases, typecheck and actual browser workflow passed. Final named followup review and full CI remain pending.
