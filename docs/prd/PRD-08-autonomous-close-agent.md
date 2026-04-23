# PRD-08: Autonomous Close Agent

**Status:** `DRAFT`
**Priority:** P0 — This is the flagship outcome every preceding PRD was quietly setting up. When the agent can close a typical SMB month unattended at <2% exception rate, IsaFlow stops competing with Xero/Sage and starts competing with outsourced bookkeeping. Price ceiling goes from R600/month (software) to R6,000/month (software + service without the service cost).
**Source specs:** PRD-05 §11 ("Fully-autonomous close" out-of-scope note), existing `isaflow-month-end` + `isaflow-year-end` skills, Vic.ai / Booke AI / Ramp autonomous ledger benchmarks, SA month-end timing studies (Deloitte / PwC mid-market reports 2024-2025).
**Related modules:** **All of them.** This is the orchestrator that runs everything.

---

## 1. Problem Statement

The skills `isaflow-month-end` and `isaflow-year-end` exist. They describe the exact sequence — post draft journals, reconcile bank, run VAT, lock period — step by step. A human currently reads them and does the work. This works for one company at a time.

What's missing:

1. **No orchestrator** — nothing walks the steps, confidence-gates each decision, and escalates uncertainty back to a human.
2. **No memory between months** — the system re-decides "which GL account for Telkom" every period instead of learning.
3. **No explanation surface** — when the agent posts R4,532 to "Motor Expenses", the user wants to see *why*: "matched bank transaction, supplier rule active, confidence 0.97".
4. **No backstop** — if the agent posts something wrong, reversing is a manual dance. No one-click undo of the agent's session.

Three unlocks:

| Without the agent | With the agent |
|---|---|
| Bookkeeper opens 10 draft journals, posts them one by one, 20 minutes | Agent posts them in 12s with a per-JE confidence score |
| Bank recon: 400 unmatched transactions at month-end | Agent clears 380, queues 20 for human (90%+ automation) |
| "Did we close April yet?" — human checks a dashboard | Agent reports at 06:00 on day 1 of the new month: "April closed. TB balanced. 2 items need review." |
| Explainability = blame the bookkeeper | Every agent action emits a full reasoning trace → audit pack link |

The *structural* point: IsaFlow owns the ledger, the supplier rules (PRD-05 Phase 3), the evidence graph (Phase 2), the fraud signals (Phase 11), and now (PRD-06) the AR symmetric side. That's the full information set a junior bookkeeper would consult. The agent is the one that can consult it in parallel across every client in 30 seconds.

---

## 2. What Already Exists

| Component | Status | Path |
|---|---|---|
| `isaflow-month-end` skill (13-step checklist) | ✅ Shipped | `/home/hein/.claude/skills/isaflow-month-end/SKILL.md` |
| `isaflow-year-end` skill | ✅ Shipped | `/home/hein/.claude/skills/isaflow-year-end/SKILL.md` |
| Auto-publish gate (Phase 3 PRD-05) | ✅ Shipped | `autoPublishGateService.ts` |
| Bank rule engine | ✅ Shipped | `bank-rules-apply.ts`, `bankRulesService.ts` |
| Three-way match | ✅ Shipped (PRD-05 Phase 4) | `supplierInvoiceWorkflowService.ts` |
| Provisional JEs (bank-first) | ✅ Shipped (Phase 5) | `provisionalJeService.ts`, `needs_evidence` flag |
| Expectation engine + missing-invoice chase | ✅ Shipped (Phase 6) | `expectationEngineService.ts`, `missingInvoiceChaseService.ts` |
| Statement recon | ✅ Shipped (Phase 7) | `supplierStatementReconService.ts` |
| Evidence-first posting (`posting_agent`) | ✅ Shipped (Phase 2) | — |
| Confidence score on VLM extraction | ✅ Shipped | `vlmInvoiceService.ts` |
| Agent orchestrator | ❌ Missing | — |
| Per-action reasoning log | ❌ Missing | — |
| One-click rollback of an agent session | ❌ Missing | — |
| Continuous accrual (not wait-for-close) | ❌ Missing | — |
| Per-tenant agent configuration (aggressive / conservative) | ❌ Missing | — |

---

## 3. Strategic Bet

> **Most accounting software is a UI on a database. The next generation is a process running on the database. The UI becomes a dashboard to the agent, not the place you do work.**

Two consequences:

- **Pricing break-out.** A Xero-shaped product caps at the price of software. An autonomous-ledger product prices against the labour it replaces. R6,000/month competes with outsourced bookkeeping, not Xero.
- **Moat deepens every week the agent runs.** Each correction a human makes is training data. Supplier-rule learning loop (PRD-05 Phase 3) already proves this pattern on a narrow slice. Extending to every posting path compounds the accuracy advantage.

Crucially, the agent is **not** a chat interface. It's a supervised autonomous process with observability and rollback. Chat comes later (PRD-09 candidate?) — first we make the engine trustworthy.

---

## 4. Data Model Changes

### 4.1 Agent Sessions

```sql
CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('cron_daily','cron_month_end','manual','api')),
  scope text NOT NULL CHECK (scope IN ('daily_ingestion','month_end','year_end','ar_dunning')),
  started_at timestamptz NOT NULL DEFAULT NOW(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','completed','failed','paused','rolled_back')),
  -- Outcome summary
  actions_executed int NOT NULL DEFAULT 0,
  actions_escalated int NOT NULL DEFAULT 0,
  actions_skipped int NOT NULL DEFAULT 0,
  amount_posted numeric(18,2) NOT NULL DEFAULT 0,
  -- Config snapshot
  config_snapshot jsonb NOT NULL,
  -- Reversal handle
  rollback_bundle_id uuid REFERENCES agent_rollback_bundles(id)
);

CREATE INDEX idx_agent_sessions_company
  ON agent_sessions(company_id, started_at DESC);
```

### 4.2 Agent Actions (reasoning log)

```sql
CREATE TABLE agent_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  step text NOT NULL,                         -- 'post_draft_je' | 'apply_bank_rules' | 'match_receipt' | ...
  entity_type text,                           -- 'gl_journal_entry' | 'bank_transaction' | 'customer_invoice'
  entity_id uuid,
  action text NOT NULL,                       -- 'post' | 'match' | 'allocate' | 'skip' | 'escalate'
  confidence numeric(5,4),
  reasoning jsonb NOT NULL,                   -- structured — inputs, rules triggered, scores
  outcome text NOT NULL,                      -- 'success' | 'escalated' | 'failed' | 'skipped_rule'
  error text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_actions_session
  ON agent_actions(session_id, created_at);
CREATE INDEX idx_agent_actions_entity
  ON agent_actions(entity_type, entity_id, created_at DESC);

-- Example reasoning payload:
-- {
--   "inputs": { "bank_tx_id": "…", "amount": 850, "description": "SHELL 4G SANDTON" },
--   "rules_triggered": [
--     { "rule_id": "…", "type": "bank_rule", "confidence": 0.95 },
--     { "rule_id": "…", "type": "supplier_rule", "supplier": "Shell", "gl": "5600 Fuel" }
--   ],
--   "gate_decision": "auto_publish",
--   "duplicate_check": "miss",
--   "thresholds": { "min_confidence": 0.90, "max_amount": 5000 }
-- }
```

### 4.3 Rollback Bundles

```sql
CREATE TABLE agent_rollback_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  executed_at timestamptz,                    -- null until rollback runs
  rollback_plan jsonb NOT NULL,               -- array of reverse operations, in order
  status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready','executed','expired','failed'))
);

-- Rollback plan is an explicit inverse-ops script, e.g.:
-- [
--   { "op": "reverse_journal_entry", "je_id": "…" },
--   { "op": "unallocate_payment", "allocation_id": "…" },
--   { "op": "unmatch_bank_transaction", "bank_tx_id": "…" }
-- ]
-- Expires after 72h; after that the Phase 12 chain anchor locks state and
-- rollback must be a manual reversal journal.
```

### 4.4 Agent Configuration

```sql
-- Per-company agent config. Starts conservative; users opt into more
-- automation step by step. Every knob has a safe default.
CREATE TABLE company_agent_config (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  -- Mode
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'advisory'
    CHECK (mode IN ('off','advisory','supervised','autonomous')),
  -- Per-action gates
  post_drafts_enabled boolean NOT NULL DEFAULT true,
  post_drafts_max_amount numeric(18,2) DEFAULT 10000,
  apply_bank_rules_enabled boolean NOT NULL DEFAULT true,
  match_receipts_enabled boolean NOT NULL DEFAULT false,    -- off until tenant proves comfortable
  match_receipts_min_confidence numeric(5,4) DEFAULT 0.95,
  run_month_end_enabled boolean NOT NULL DEFAULT false,     -- big one — opt-in
  -- Scheduling
  daily_run_time time DEFAULT '06:00',
  month_end_day_of_month int DEFAULT 3,                     -- runs on day 3 of next month
  timezone text DEFAULT 'Africa/Johannesburg',
  -- Safety
  max_actions_per_session int DEFAULT 500,
  max_amount_per_session numeric(18,2) DEFAULT 500000,
  require_review_above_amount numeric(18,2) DEFAULT 50000,
  pause_on_error boolean NOT NULL DEFAULT true,
  -- Notifications
  notify_on_completion boolean NOT NULL DEFAULT true,
  notify_on_escalation boolean NOT NULL DEFAULT true,
  notify_email text,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
```

### 4.5 Escalation Queue

```sql
CREATE TABLE agent_escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  action_id uuid REFERENCES agent_actions(id),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reason text NOT NULL,
  category text NOT NULL CHECK (category IN ('low_confidence','amount_threshold','rule_conflict','duplicate_risk','fraud_signal','unmatched','unknown_supplier')),
  severity text NOT NULL DEFAULT 'normal' CHECK (severity IN ('info','normal','high','critical')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','resolved','dismissed')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  resolved_at timestamptz,
  resolved_by text,
  resolution text
);

CREATE INDEX idx_agent_escalations_company
  ON agent_escalations(company_id, status, created_at DESC);
CREATE INDEX idx_agent_escalations_pending
  ON agent_escalations(severity, created_at DESC) WHERE status = 'pending';
```

---

## 5. Services & APIs

### 5.1 New services (`src/modules/accounting/services/agent/`)

| Service | Responsibility |
|---|---|
| `agentOrchestrator.ts` | Top-level: loads company config, kicks off the right scope, writes session + actions. |
| `stepRunners/postDrafts.ts` | Walks `journal_entries.status = 'draft'`, confidence-gates, posts via existing workflow. |
| `stepRunners/applyBankRules.ts` | Wraps `bankRulesService.apply` with session context. |
| `stepRunners/matchReceipts.ts` | Uses PRD-06 `receiptMatchService` with agent confidence gate. |
| `stepRunners/reconcileSupplierStatements.ts` | Runs each active statement reconciliation. |
| `stepRunners/runVat.ts` | VAT201 dry-run; flags any classification mismatches as escalations. |
| `stepRunners/lockPeriod.ts` | Final gate: only runs if all prior steps return no critical escalations. |
| `reasoningLogger.ts` | Consistent `{inputs, rules_triggered, gate_decision, thresholds}` JSON payloads. |
| `rollbackService.ts` | Builds + executes rollback plans. Uses DB transaction + reverse ops. |
| `agentTelemetry.ts` | Metrics for observability — per-step timings, confidence histograms, escalation rate. |
| `agentScheduleCron.ts` | Cron entry point — loads due companies from `company_agent_config.daily_run_time`. |

### 5.2 New endpoints

```
GET    /api/accounting/agent/config                   current company config
PATCH  /api/accounting/agent/config                   update knobs
POST   /api/accounting/agent/run                      body: { scope: 'daily_ingestion' | 'month_end' | 'year_end' }

GET    /api/accounting/agent/sessions                 list recent sessions
GET    /api/accounting/agent/sessions/[id]            session + actions + escalations
POST   /api/accounting/agent/sessions/[id]/rollback   trigger rollback (within 72h window)

GET    /api/accounting/agent/escalations              pending queue
POST   /api/accounting/agent/escalations/[id]/resolve body: { resolution }
POST   /api/accounting/agent/escalations/[id]/dismiss

GET    /api/accounting/agent/telemetry                per-company aggregates

POST   /api/cron/agent-daily                          X-Cron-Secret; walks due companies
POST   /api/cron/agent-month-end                      X-Cron-Secret; day 3 of each month
```

### 5.3 Modifications to existing services

- `journalEntryService.postJournalEntry` — accepts optional `{ sessionId, actionPayload }`, stamps `posting_agent = 'agent:v<version>'`, writes action row.
- `autoPublishGateService.decide` — returns richer reasoning JSON for the action log.
- `bankAllocationService.allocate` — same agent-session parameter pattern.
- Month-end / year-end skills transform from Claude-facing instructions into **executable step runners** (each step maps to a `stepRunners/*.ts` module).

---

## 6. UI Pages

### 6.1 New

| Route | Purpose |
|---|---|
| `/accounting/agent` | Agent home — current mode, last session summary, "Run now" button |
| `/accounting/agent/sessions` | History — timeline, outcome chips, rollback affordance |
| `/accounting/agent/sessions/[id]` | Detail — action list, reasoning trace, escalations, rollback button |
| `/accounting/agent/escalations` | Queue — paginated list, keyboard-navigable, 1-click resolve / dismiss |
| `/accounting/agent/config` | Mode dial + per-action toggles + thresholds + schedule |
| `/accounting/agent/telemetry` | Per-tenant: automation rate, avg confidence, escalation rate over 30/90/365 days |

### 6.2 Modifications

- **Dashboard:** hero widget — "Agent closed April. 97% auto-posted. 8 items need your review."
- **Every list (JE, bank, AR, AP):** filter toggle "Show agent posts" with a subtle agent badge in the row.
- **Journal entry detail:** "Agent reasoning" tab — structured view of the action's reasoning JSON.
- **Reports > TB:** each `posting_agent = 'agent'` line carries a chevron → action detail.

---

## 7. Phased Delivery

### Phase 1 — Orchestrator Shell + Session Model (1 week) `P0`

- Migrations: sessions, actions, rollback bundles, config
- `agentOrchestrator.ts` stub that loads config, opens a session, closes it
- `POST /agent/run` endpoint (does nothing yet but creates a session)
- Session list UI + empty-state
- **Exit criteria:** click "Run now"; session row appears with `status='completed'`, `actions=0`.

### Phase 2 — Post-Drafts Step Runner (1 week) `P0`

- `stepRunners/postDrafts.ts` wraps existing journal-entry post with session context
- Reasoning log for each post: confidence from source (AI vs. manual), amount, GL accounts touched
- Escalation: post that would require review-above-amount threshold
- **Exit criteria:** 10 draft JEs; run agent; 8 auto-post, 2 escalate (over-threshold); rollback reverses all 8 in one click.

### Phase 3 — Bank Rules + Receipt Match (2 weeks) `P0`

- `applyBankRules` + `matchReceipts` step runners
- Uses PRD-05 Phase 3 gate + PRD-06 Phase 4 receipt match
- Escalation category: unmatched > N days; amount > threshold
- **Exit criteria:** month of bank data with 500 transactions; agent clears ≥80% with confidence ≥0.9.

### Phase 4 — Month-End Choreography (2 weeks) `P0`

- `stepRunners/reconcileSupplierStatements` + `runVat` + `lockPeriod`
- Ordered execution via the orchestrator; halt on any critical escalation
- VAT dry-run that catches classification gaps before closing
- **Exit criteria:** empty-company walk-through with zero escalations completes in <30s; closes the period with balanced TB.

### Phase 5 — Escalation Queue UX (1 week) `P1`

- Queue page, keyboard navigation, bulk actions
- "Teach the agent" — resolving an escalation updates the relevant rule (bank_rules / supplier_coding_rules)
- **Exit criteria:** bookkeeper resolves 20 escalations in <5 minutes; next run auto-handles the same patterns.

### Phase 6 — Rollback (1 week) `P1`

- `rollbackService` executing reverse ops in a single DB transaction
- 72h window with visible countdown
- After-anchor rollback requires a reversal journal (not a physical rollback)
- **Exit criteria:** run agent on demo company; click rollback 30 minutes later; TB returns to pre-run state; audit log shows 1 rollback event.

### Phase 7 — Continuous Mode (2 weeks) `P1`

- Agent runs daily on its own schedule, not just at month-end
- Provisional JEs become agent-posted directly (PRD-05 Phase 5 integration)
- "Agent diary" — human-readable summary emailed each morning
- **Exit criteria:** 30 days of daily agent runs; cumulative automation ≥75% by day 15.

### Phase 8 — Autonomous Mode + Trust Metrics (2 weeks) `P2`

- `mode='autonomous'` unlocks `run_month_end` + `lock_period` on schedule
- Public trust scoreboard per tenant: month-over-month escalation rate, dispute-free windows
- Monthly certification: "Closed by agent, verified by <accountant>" badge on audit packs
- **Exit criteria:** 3 tenants run fully autonomous for 2 consecutive months with <2% escalation rate.

### Phase 9 — Explain via Natural Language (1 week) `P2`

- Per-action reasoning JSON → Claude Haiku → plain-English explanation on hover
- "Why was this R4,532 posted here?" shows a 2-sentence answer
- **Exit criteria:** every agent action has a one-click explanation visible in <500ms.

**Total estimated effort:** 13–15 engineer-weeks; P0 (Phase 1-4) ships in 6 weeks and delivers supervised month-end close.

---

## 8. Success Metrics

| Metric | Baseline | Target (12 weeks post-launch) |
|---|---|---|
| % JE postings by agent (across enabled tenants) | 0% | ≥70% |
| Median month-end close time | 4 hours human work | ≤30 min (mostly review) |
| Escalation rate per 1,000 actions | n/a | ≤30 (3%) |
| Rollback-in-72h events per month | n/a | ≤2 per 100 sessions |
| Tenants opted into `supervised` mode | 0 | ≥20 |
| Tenants opted into `autonomous` mode | 0 | ≥5 |
| Day-1 agent-closed P&L availability | n/a | ≥80% of enabled tenants |

---

## 9. Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Agent posts a bad batch at scale, across tenants | Low | Very High | Per-tenant pause-on-error; global kill switch; rollback bundles keep 72h window |
| Confidence miscalibration leads to over-posting | Med | High | Histogram + dashboard per step; auto-tighten thresholds if drift detected |
| Users feel loss of control | Med | Med | Advisory mode first; everything visible in escalations queue; explainability traces |
| Rollback window elapses before issue found | Low | High | Anchoring + reversal journal pattern (PRD-07 dependency) for after-anchor undo |
| Dynamic rules conflict (two rules target the same tx) | Med | Med | Deterministic rule priority: supplier_rule > bank_rule > agent-default; conflict emits escalation |
| Training data leaks across tenants | Low | Very High | Rules are tenant-scoped; learned patterns never cross `company_id` boundary |
| Escalation fatigue — too many low-value flags | Med | Med | Weekly "escalation quality" review: deduplicate, auto-dismiss with pattern learning |

---

## 10. Open Questions

1. **Default mode for new tenants** — `off` or `advisory`? Recommendation: `off`; opt-in on a "get started with the agent" wizard.
2. **Who pays for agent time** — per-action, per-tenant flat, or included in plan tier? Recommendation: included in paid tiers; rate-limit free tier.
3. **Natural-language explain latency** — block UI until Haiku responds, or show JSON inline + NL on hover? Recommendation: JSON default; NL on hover + cached.
4. **Multi-currency** — agent walks in reporting currency only, or per-currency ledgers? Start reporting currency; multi-currency after PRD-06 AR matures.
5. **Year-end** — same agent scope, or a separate year-end skill with tax-year rollover? Recommendation: separate scope `year_end` with its own step runners.

---

## 11. Out of Scope (for this PRD)

- **Chat interface / "ask the agent"** — covered by a later PRD; agent here is scheduled / batch-mode.
- **Multi-tenant orchestration** — e.g. firm-wide "close all 40 clients at once" — deferred to a later practice-management PRD.
- **LLM fine-tuning** — rules + deterministic thresholds first; generative ML is not on the critical path.
- **Cross-client anomaly detection** — overlap with PRD-05 Phase 11 graph; agent consumes signals but doesn't build new ones.
- **Regulatory filing on the user's behalf** — PRD-09 scope.

---

## 12. Dependencies

- PRD-05 evidence-first ledger (shipped)
- PRD-05 Phase 3 auto-publish gate (shipped)
- PRD-05 Phase 11 fraud graph (shipped)
- PRD-06 receipt match service (Phase 4 of PRD-06)
- PRD-07 content-hash + rollback-after-anchor pattern (Phase 2+ of PRD-07)
- Claude Haiku API for NL-explain (Phase 9)
- Cron infrastructure (shipped via PRD-05 Phase 6)
