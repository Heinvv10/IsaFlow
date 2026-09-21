# K-008 correction plan

Baseline ebeac9ca. The preserved real PostgreSQL API reproduction fails because a quoted non-allowlisted relation returns own-company endpoint fields. Allowed quoted customers and foreign-company rejection controls pass. No cross-tenant disclosure is claimed.

Replace regex relation discovery with parsed relation validation. Walk nested SELECTs and lexical CTE bodies; validate exact relation names and explicit public schema, rejecting unknown schemas, malformed SQL and unsupported statement forms. Preserve the independent tenant-scope gate and existing query response contract. Cover quoted relations, comma joins, nested relations and CTE scoping with unit tests, then rerun the preserved real database API fixture.

No schema or historical-data changes. Rollback is the standard prior application release. SQL-executing function capability is a separate investigation and must remain registered if confirmed. Independent named-commit review, full CI, PR checks, deployment and affected live verification remain required.
