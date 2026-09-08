# K-006 local verification

Restored the broken opening-balance writer through existing draft/post journal services with tenant ownership, active posting-account, exact-cent balance and open-period validation. PostgreSQL locks prevent account deactivation or period closure between validation and posting. No migration or shared journal-service change.

17 PostgreSQL workflow cases pass, including rollback after real draft creation, concurrent submissions, lock blocking, CSV export/setup completion and scoped historical inventory. The original valid and foreign cases failed500 before the fix; downstream export/setup assertions separately failed before their reader updates. 416 GL unit tests passed,5 skipped. Typecheck passed. Actual browser form posted123.45 debit/credit and reconciled the database cache. Browser requests were restricted to localhost; blocked external fonts produced fallback typography in the screenshot.

Independent named review and full CI are pending. No merge, deployment, production write or historical repair occurred.
