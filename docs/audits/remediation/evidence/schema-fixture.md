# Empty current-schema fixture

Historical committed-migration replay remains separately open at migration 253. To test current application SQL/RLS contracts without inventing missing historical columns, captured **schema only** from `isaflow-supabase-db`, database `isaflow`, using pg_dump for public/auth/app schemas. No production rows were copied and no production writes were performed.

Source dump: `/tmp/isaflow-remediation-schema-with-grants.sql`; SHA256 `ad93bbd6286f113bfc68a564f9eb93abb232aa738d337a2754bb90d6c8677f5c`. Owners, grants, policies, functions and triggers are preserved. Roles were recreated without production login credentials; BYPASSRLS flags were retained. The target's existing empty public schema was retained (the duplicate CREATE SCHEMA public statement was omitted). Required real extensions were installed: btree_gin, pg_trgm, uuid-ossp, vector, pgcrypto, btree_gist.

Target container `isaflow-remediation-schema-pg-20260908`, image `pgvector/pgvector:pg16`, bound to 127.0.0.1:33140, database `isaflow_schema_fixture`. postgres and platform_admin have only the disposable password `remediation-local-only`; platform_admin LOGIN is enabled solely in this fixture. Restore completed with exit 0: see schema-fixture-restore.log. Post-restore checks: 293 public tables, 228 public policies, users=0 and companies=0 before synthetic fixtures. PostgreSQL version differs from the source's 15.x; record this limit for version-specific behavior.

Read-only source metadata confirms users.id varchar, company_users.user_id text, products.code and products.current_stock; no products.sku/qty_on_hand. See live-schema-metadata.log. This supports diagnosing historical replay drift but does not repair the original migrations or establish full backlog acceptance.

This fixture permits real SQL/role/transaction tests against current schema. It is not a substitute for the separately required committed-migration replay/upgrade checks. Raw schema files remain local rather than being published with the draft PR.
