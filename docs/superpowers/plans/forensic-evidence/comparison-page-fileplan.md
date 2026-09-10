# Retained comparison header and paging

Base e00daa760; owned production files auditComparisonReadHeader.ts and auditComparisonPageService.ts only. No schema, worker, transport or registry changes.

Authenticate the saved compare request without treating its original delegation expiry as current reader authority. Read both original authenticated source indexes with the current issued caller, then bind result identity to the succeeded pointer, current generation and retained result lease. Compare ordered source metadata, original side populations, rule version and permission union. Independently count all four output sections in tenant/job/generation/lease-scoped SQL before returning the authenticated header.

The strict page request accepts comparisonId UUID, one closed section, limit 1–100 (default 100), and an untrusted canonical decimal position. Keyset reads cap both rows and cumulative encrypted bytes at 2 MiB; each position must be contiguous and each encrypted item must authenticate against the opened header. The returned canonical hash is the publisher's authenticated full-result hash; a page does not independently recompute it. No read starts a worker, converts a legacy source, or loads original binary material.

Tests first: missing modules; unavailable/queued result; independent census omission; invalid input and shifted positions; source/header inconsistency; authority refusal. Actual PostgreSQL: create two real snapshots and run a real comparison worker producing at least 250 changes; read three pages and recompute the full digest; same-company second reader; foreign tenant; current source-domain revocation; tampered header/item; missing output; queued job remains untouched. Use existing synthetic fixture and explicitly close pools. No PostgreSQL or static run until the root's exclusive lease.

## Verification

Tests-first f450e06a7: missing module RED1871; four units subsequently GREEN. Actual tests-first50a729877 creates real snapshots and real worker output (250 additions), no fabricated comparison headers/chunks. Initial five PG24564PASS. Expanded combined31023 passed13/14, including all eight existing worker regressions; additional oversized fixture was correctly rejected by migration668's65,536-byte CHECK (23514). Retained that schema refusal assertion without weakening DDL.

Final45157 terminal0: six paging PostgreSQL cases PASS; pool closed. Record pages100/100/50; all four sections reconciled and full digest reproduced. Authorized second-person read works while requester-owned status refuses. Foreign/current payroll and banking revocation, header and item tamper, census omission outside requested page, queued no-work and expired original delegation tested. Original full seals deliberately unavailable, proving metadata-only retained reads. Privileged synthetic mutations restored in finally blocks.

Static4310 terminal0: dedicated transitive source/test TypeScript, production and typed-test ESLint zero warnings, four units PASS. Logs in mcp-forensic-artifacts-20260909: comparison-page-unit-red.log, comparison-page-pg.log, comparison-page-regression.log, comparison-page-final-pg.log, comparison-page-static.log. All owned resources closed/released. Source candidate63c101464; independent named review pending.

Original index headers lack cutoff/capturedAt. Reader verifies ordered IDs/hashes, permissions and side populations against those authenticated headers; dates remain authenticated by publisher result envelope. No mutable metadata or binary fallback. This is local bounded reader proof, not transport registration, isolated-process or100k comparison proof.
