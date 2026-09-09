# Payment release storage checkpoint

Migration 636 defines immutable preparations, encrypted release intents, owned items, per-payment reservations and an outbox. Preparations bind the selected verified bank version and exact ZAR cents. Each payment can be reserved for only one release intent across channels. Outbox column grants and a trigger permit ready → attempting → terminal transitions, freeze attempt identity/time and forbid resetting uncertain or completed attempts.

A real immutable mandatory policy row is seeded for each existing and newly created company. Its independent approver role is admin; application users cannot change or delete it. Service-side rule loading and execution integration remain separate required work.

After recovery, six PostgreSQL tests failed before the migration. The migration then applied twice successfully in the disposable database. The combined release-schema and registry suite passed 11 tests (2.94s). Commands used Node 22.23.1, Bun 1.3.9 and `vitest.integration.config.ts`; logs are retained in sibling `mcp-forensic-artifacts-20260909/recovery-release-*` files.

The release tests establish catalog constraints, actual new-company policy seeding, tenant visibility and policy-delete denial. They do not yet prove complete outbox transitions, cross-intent reservation races, supplier/preparation consistency or provider outcomes. Worker acceptance must exercise those behaviors against actual PostgreSQL and fake providers before release capability is considered complete. No provider or production operation occurred.
