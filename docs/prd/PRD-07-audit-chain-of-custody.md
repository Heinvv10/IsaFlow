# PRD-07: Audit Chain of Custody

**Status:** `DRAFT`
**Priority:** P1 — Extends PRD-05 Phase 12 from "signed PDF" to "provably untampered". Turns an audit pack from a snapshot-with-a-hash into a link in a tamper-evident chain, unlocking auditor-grade non-repudiation without giving auditors raw DB access.
**Source specs:** PRD-05 §11 Out-of-scope ("Blockchain / on-chain audit anchoring"), Big-4 audit methodology (ISA 500 evidence, ISA 315 risk assessment), Surety / OpenTimestamps protocol study.
**Related modules:** AFS (`audit_trail_exports`), GL (`gl_journal_entries`), PRD-05 evidence graph.

---

## 1. Problem Statement

PRD-05 Phase 12 seals each audit pack with SHA-256. That proves the PDF hasn't been altered **since** it was built. What it doesn't prove:

- the **GL state** at build time matched what the DB held during the period;
- that no one rebuilt the pack a week later with a quietly-edited journal entry;
- that two auditors reviewing the same period get the same root hash;
- that the **auditor** can independently verify the seal without trusting our server.

For SMBs today this is fine — their auditor is a CA(SA) who trusts IsaFlow. For larger clients (listed entities, JSE debt issuers, regulated FSPs) the standard shifts: they need evidence that survives an adversarial audit and can be verified against an external root of trust.

Three unlocks when each period's evidence is Merkle-rooted and the root is anchored to a public timestamp service:

| Without chain of custody | With chain of custody |
|---|---|
| Auditor has to trust the server returning the PDF is honest | Auditor computes the Merkle root from the JE hashes in the pack, compares to the publicly-timestamped anchor |
| Back-dated journal edits are invisible to the pack | Any edit changes the root, which mismatches the anchor — caught at verification |
| Two tenants with the same period get different packs if the DB shifts | Root is deterministic; mismatch = evidence |
| Regulated clients need AFS + separate "trusted third party" attestation | The anchor service IS the trusted third party; IsaFlow becomes eligible for regulated workloads |

This is not a cryptocurrency play. "On-chain" here means committing a 32-byte hash to a public timestamping service (OpenTimestamps on Bitcoin, or a signed RFC3161 timestamp from a trusted TSA). No tokens, no gas fees, no wallet UX.

---

## 2. What Already Exists

| Component | Status | Path |
|---|---|---|
| `audit_trail_exports` table + PDF bundle | ✅ Shipped (PRD-05 Phase 12) | mig-425 |
| SHA-256 seal on pack bytes | ✅ Shipped | `auditTrailExportService.ts` |
| Portal session auth for auditors | ✅ Shipped | same |
| GL immutability pattern (post → no edit) | ⚠️ Partial | Posting locks a JE, but reversal is allowed; no event log of edits beyond status transitions |
| Per-JE hash | ❌ Missing | — |
| Merkle tree of period JEs | ❌ Missing | — |
| External timestamp anchoring | ❌ Missing | — |
| Client-side verifier | ❌ Missing | — |
| Evidence-bundle hashing (source docs included in the tree) | ❌ Missing | — |

---

## 3. Strategic Bet

> **The PDF says 'I am sealed'. The chain says 'I was sealed AT THIS TIME, and here's a public record you can check'. That's the jump from 'trustworthy vendor' to 'works in regulated environments'.**

Pricing consequence: audited-chain packs unlock a separate SKU at ~R2,000/client-period, or an annual subscription for firms doing 50+ clients. Structurally, it's a cross-sell onto the existing Phase 12 UX, so incremental CAC is zero.

---

## 4. Data Model Changes

### 4.1 Per-JE Content Hash

```sql
-- JE content hash is deterministic from its columns + child lines.
-- Computed at post time, stored for fast Merkle-tree rebuild later.
ALTER TABLE gl_journal_entries
  ADD COLUMN IF NOT EXISTS content_hash text,     -- sha256 of canonical JSON
  ADD COLUMN IF NOT EXISTS content_hashed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_je_content_hash
  ON gl_journal_entries(content_hash) WHERE content_hash IS NOT NULL;

-- Canonical JSON shape for hashing (deterministic key order, RFC8785 JCS):
-- { company_id, entry_number, entry_date, source, reference,
--   posting_agent, created_at, lines: [{gl_account_id, debit, credit, description, ...}] }
-- Hash is frozen at post time; reversal creates a NEW reversal JE (also hashed),
-- leaving the original's content_hash intact.
```

### 4.2 Merkle Trees Per Period

```sql
CREATE TABLE audit_merkle_roots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  je_count int NOT NULL,
  leaf_count int NOT NULL,                       -- JE hashes + source-doc hashes + manual-override hashes
  merkle_root text NOT NULL,                     -- sha256 hex
  tree_snapshot jsonb NOT NULL,                  -- full binary tree serialised for re-verify
  built_at timestamptz NOT NULL DEFAULT NOW(),
  audit_export_id uuid REFERENCES audit_trail_exports(id) ON DELETE SET NULL,
  UNIQUE (company_id, period_start, period_end)
);

CREATE INDEX idx_audit_merkle_company
  ON audit_merkle_roots(company_id, period_end DESC);
```

### 4.3 External Anchors

```sql
CREATE TABLE audit_chain_anchors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merkle_root_id uuid NOT NULL REFERENCES audit_merkle_roots(id) ON DELETE CASCADE,
  anchor_type text NOT NULL CHECK (anchor_type IN ('opentimestamps','rfc3161','sigsum')),
  anchor_data bytea NOT NULL,                    -- OTS proof blob / RFC3161 token / etc.
  anchor_data_sha256 text NOT NULL,              -- integrity seal
  submitted_at timestamptz NOT NULL DEFAULT NOW(),
  confirmed_at timestamptz,                      -- null until BTC block confirms (can take ~1h)
  confirmation_block_height bigint,
  verification_url text,                         -- public URL to re-verify
  provider_request_id text,
  error text
);

CREATE INDEX idx_audit_anchors_root
  ON audit_chain_anchors(merkle_root_id, submitted_at DESC);
CREATE INDEX idx_audit_anchors_unconfirmed
  ON audit_chain_anchors(submitted_at) WHERE confirmed_at IS NULL;
```

### 4.4 Edit-Event Log (defence-in-depth)

```sql
-- Even though posted JEs are immutable in practice, some tables
-- (fiscal_periods, gl_accounts) can still change. Log everything that
-- could invalidate a Merkle root so auditors can see why a root drifted.
CREATE TABLE audit_sensitive_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  column_name text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  edited_by text NOT NULL,                       -- users.id or 'system'
  edited_at timestamptz NOT NULL DEFAULT NOW(),
  ip_address inet
);

CREATE INDEX idx_sensitive_edits_company
  ON audit_sensitive_edits(company_id, edited_at DESC);

-- Populated via per-table AFTER UPDATE triggers. Opt-in per table.
```

---

## 5. Services & APIs

### 5.1 New services (`src/modules/accounting/services/chain/`)

| Service | Responsibility |
|---|---|
| `contentHashService.ts` | Canonical-JSON + SHA-256 for journal entries. Called at post time via a DB trigger or the posting-service. |
| `merkleTreeService.ts` | Build a Merkle tree from JE hashes + source-doc hashes. Return root + full snapshot (for client verify). |
| `openTimestampsService.ts` | Submit roots to the OTS public calendar; poll for Bitcoin-block confirmation. |
| `rfc3161Service.ts` | Alternative anchor — signed timestamp from a trusted TSA (DigiCert, IdenTrust). Faster confirmation, paid. |
| `chainVerifierService.ts` | Re-verify a pack's root against the anchor. Used server-side for the "verify now" UI action. |
| `sensitiveEditMonitorService.ts` | Watches `audit_sensitive_edits` and flags if an edit post-dates a Merkle root containing the affected row. |

### 5.2 New endpoints

```
POST   /api/accounting/chain/hash-backfill       # admin — compute missing content_hash rows
POST   /api/accounting/chain/roots               body: { periodStart, periodEnd } → builds Merkle tree + anchors
GET    /api/accounting/chain/roots               list roots for this company
GET    /api/accounting/chain/roots/[id]          root + anchor status
GET    /api/accounting/chain/roots/[id]/proof    returns snapshot + anchors; auditor can verify offline
POST   /api/accounting/chain/roots/[id]/verify   triggers re-verify; returns pass/fail
GET    /api/accounting/chain/sensitive-edits     list drift-causing edits (filter by root)

POST   /api/cron/chain-confirm-anchors           X-Cron-Secret; polls OTS for BTC confirmations
POST   /api/cron/chain-drift-scan                X-Cron-Secret; checks roots for drift

# Extension to PRD-05 Phase 12 export
POST   /api/accounting/audit-exports             # new body option: { anchor: true }
GET    /api/accounting/audit-exports/[id]/verify # summary: pack hash, merkle root, anchor status
```

### 5.3 Modifications to existing services

- `gl/journalEntryService.ts` — after `postJournalEntry`, compute and persist `content_hash`. New trigger `tg_je_content_hash` as a safety net.
- `auditTrailExportService.buildExport` — accept `{ anchor: true }`; on build, compute the Merkle root alongside the PDF and optionally kick off anchoring.
- PDF pack cover page — when chained, show the Merkle root + anchor-verification URL in the header.

---

## 6. UI Pages

### 6.1 New

| Route | Purpose |
|---|---|
| `/accounting/audit-packs/[id]/chain` | Per-export chain panel — Merkle root, anchors, confirmation state, verify button |
| `/accounting/audit-packs/chain-drift` | List roots whose underlying rows have been edited since anchoring |
| `/audit-portal/[sessionId]/verify` | Auditor-facing: paste the pack's Merkle root; verifies against the anchor independently of us |

### 6.2 Modifications

- **Pack list:** add "Anchor" column (✓ confirmed / ⏳ pending / ✗ failed); show BTC block height when confirmed.
- **Phase 12 build modal:** checkbox "Anchor this pack to Bitcoin timestamp (takes ~1 hour to confirm)" + price tag if on a paid tier.
- **Pack detail page:** "Chain of Custody" section shows root hash, anchor type, `verification_url` link, timestamp.

---

## 7. Phased Delivery

### Phase 1 — Content-Hash Every JE (1 week) `P0`

- Migration: `gl_journal_entries.content_hash` + backfill
- `contentHashService` with RFC8785 canonical JSON
- Trigger: post-insert hash stamp (via `journalEntryService`, not DB trigger — we want the app to own the canonicalisation)
- Backfill cron for existing rows
- **Exit criteria:** 100% of posted JEs have a `content_hash`; re-running produces the same value for the same inputs.

### Phase 2 — Merkle Trees (1 week) `P0`

- `audit_merkle_roots` table + `merkleTreeService`
- Tree shape: balanced binary, duplicated-last-leaf for odd counts (Bitcoin-style)
- `POST /chain/roots` endpoint — idempotent per period
- Extension to existing PDF pack: show Merkle root on cover page
- **Exit criteria:** build a tree for a closed period; two rebuilds produce the same root; every leaf traces to a JE or source doc.

### Phase 3 — OpenTimestamps Anchor (2 weeks) `P1`

- `openTimestampsService` — submit to calendar servers, store OTS proof blob
- Confirmation-polling cron (~1h cadence)
- Verify endpoint that reads the OTS proof and reports BTC block + confirmation depth
- **Exit criteria:** anchor a root; within 2h a cron job flips `confirmed_at` + fills `confirmation_block_height`; auditor on an isolated machine can verify the anchor using `ots verify` CLI.

### Phase 4 — RFC3161 Anchor (1 week) `P1`

- Alternative: paid TSA signed timestamp (instant confirmation, no wait)
- Per-company setting: `chain_anchor_provider = 'ots' | 'rfc3161'`
- Pricing gate: RFC3161 on paid tier only
- **Exit criteria:** anchor a root with RFC3161; confirmation is immediate; verify endpoint returns green.

### Phase 5 — Auditor Verifier (1 week) `P1`

- `/audit-portal/[sessionId]/verify` — paste the Merkle root; fetch the OTS proof from our endpoint; re-verify browser-side using `OpenTimestamps.js`
- Also download a `verify.sh` script that runs offline against `ots` CLI
- **Exit criteria:** external auditor, on an air-gapped laptop, runs `verify.sh` and gets a green ✓ for a real pack.

### Phase 6 — Sensitive-Edit Monitor (1 week) `P2`

- Triggers on `gl_accounts`, `fiscal_periods`, `companies.reporting_currency`, `companies.entity_type`
- Write to `audit_sensitive_edits` on UPDATE
- Nightly cron compares edit timestamps to anchored Merkle roots; flags drift
- **Exit criteria:** edit a GL account name; nightly scan lists it under "drift"; the pack stays green (root is for JEs, not account names) but auditor sees the history.

### Phase 7 — Bundle Verification (1 week) `P2`

- Include source-document hashes as leaves in the tree
- Extend pack verify: re-hash each source doc in storage, match against tree leaf
- **Exit criteria:** tamper with a source PDF in storage; verify returns "leaf X hash mismatch — evidence compromised".

### Phase 8 — On-Chain Dashboard (1 week) `P2`

- Public page (`/audit-portal/public/[merkleRoot]`) — anyone with the root can see the anchor status without a session token. Read-only.
- Telemetry: per-tenant count of confirmed anchors, avg confirmation latency.
- **Exit criteria:** share a Merkle root in an email; recipient confirms it's anchored without needing an account.

**Total estimated effort:** 7–9 engineer-weeks; P0 (Phase 1+2) ships in 2 weeks.

---

## 8. Success Metrics

| Metric | Baseline | Target (12 weeks post-launch) |
|---|---|---|
| % posted JEs with content_hash | 0% | 100% |
| % audit packs with Merkle root | 0% | 100% |
| % anchored packs with BTC confirmation | n/a | ≥95% within 3h |
| External-verification success rate | n/a | ≥99% (client-side verifier vs our stored proof) |
| Tenants on paid-chain SKU | 0 | ≥10 at 6 months |
| Incident count: root mismatch on verify | n/a | 0 (any mismatch = P0) |

---

## 9. Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OTS calendar downtime delays confirmation | Med | Low | 4+ calendar servers by default; degrade to RFC3161 as secondary |
| Determinism bug → different hash for same content | Low | Very High | Canonicalise via RFC8785, not ad-hoc sort; test on 10k real rows with two independent impls |
| Auditor panics on "Bitcoin" word | Med | Med | Describe as "public timestamp service (similar to notary)" — never "crypto" / "blockchain" / "NFT" |
| Edit-log gap: we miss an edit that drifts root | Low | High | Row-level-security + audit table + periodic full-tree re-hash on random sample |
| BTC tx fee spikes priceout | Low | Low | Batch-anchor: one OTS submission per 100 roots; incremental cost is $0 for consumers |
| Legal / PoPI: storing BTC tx hash = personal data? | Low | Low | PIA says no — hash is not linkable to a person |
| Client-side verifier bitrot (OpenTimestamps.js goes stale) | Med | Med | Vendor-lock via pinned git SHA; fall-forward to new package within quarter |

---

## 10. Open Questions

1. **Default anchor type** — OTS (free, ~1h confirm) or RFC3161 (paid, instant)? Recommendation: OTS default; RFC3161 behind a "Pro audit" toggle.
2. **Anchor granularity** — per period, per pack, or continuous rolling? Recommendation: per period end (monthly); an extra rolling daily root for regulated clients.
3. **PoPI angle on sensitive edits** — do we log IP? Recommendation: log for 90 days, anonymise after.
4. **What counts as a "sensitive" table** — start narrow (`gl_accounts`, `fiscal_periods`, `companies.entity_type`) or broad (every table touched by a JE)? Start narrow; expand based on audit feedback.
5. **Do we sign the PDF itself** (PAdES / X.509)? Recommendation: yes, Phase 8 — same chain root in the PDF's signature dictionary so the PDF is self-verifying in Adobe.

---

## 11. Out of Scope (for this PRD)

- **Cryptocurrency settlement** — zero intention of moving funds on chain; hash-only.
- **Smart contracts** — no conditional logic; pure timestamping.
- **DID / verifiable credentials** — the auditor's identity is out of scope; they remain an IsaFlow-side account holder.
- **Blockchain analytics / chain-of-custody for fraud investigation** — evidence pack is enough; we don't go further.
- **Per-JE anchoring** — too expensive; root is per period only.

---

## 12. Dependencies

- OpenTimestamps.org free API (Bitcoin anchoring)
- Optional RFC3161 TSA contract (DigiCert or Sectigo)
- PRD-05 audit pack infra (shipped)
- `gl_journal_entries` already includes `posting_agent` and `source_document_id` (shipped)
