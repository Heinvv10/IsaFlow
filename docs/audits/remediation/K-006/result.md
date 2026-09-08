# K-006 local verification

Restored the broken opening-balance writer through existing draft/post journal services with tenant ownership, active posting-account, exact-cent balance and open-period validation. PostgreSQL locks prevent account deactivation or period closure between validation and posting. No migration or shared journal-service change.

17 PostgreSQL workflow cases pass, including rollback after real draft creation, concurrent submissions, lock blocking, CSV export/setup completion and scoped historical inventory. The original valid and foreign cases failed500 before the fix; downstream export/setup assertions separately failed before their reader updates. 416 GL unit tests passed,5 skipped. Typecheck passed. Actual browser form posted123.45 debit/credit and reconciled the database cache. Browser requests were restricted to localhost; blocked external fonts produced fallback typography in the screenshot.

Independent named review approved a936a8b2; full CI passed at786ab01f (9,306 unit/384 component tests and production build,234 unit tests skipped). Draft PR https://github.com/Heinvv10/IsaFlow/pull/352 is stacked on R-003. No merge, deployment, production write or historical repair occurred.
