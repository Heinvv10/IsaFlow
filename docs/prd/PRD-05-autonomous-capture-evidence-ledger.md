# PRD-05: Autonomous Document Capture & Evidence-First Ledger

**Status:** `DRAFT`
**Priority:** P0 — Replaces Dext / Hubdoc / AutoEntry on IsaFlow; unlocks a structural moat by combining the capture layer with the ledger IsaFlow already owns.
**Source specs:** Dext ZA competitive research (2026-04-21), market scan of Booke AI / Vic.ai / Ramp / Saxon / Medius / Pilot.
**Related modules:** AP (`supplier_invoices`, `ai-invoice-pipeline`), Banking (`bank_transactions`, `bank-rules`, `bankMatchCandidatesService`), AR (`customer_invoices`), Documents (`documents` table, `vlmInvoiceService`), Practice (`time_entries`, `wip`), Payroll (expense claims integration).

---

## 1. Problem Statement

Dext, Hubdoc, and AutoEntry dominate SA document capture by bolting OCR onto whichever accounting ledger the client happens to use (Xero, Sage, QBO). Their structural ceiling is that **they do not own the ledger** — every step after extraction is somebody else's product, which leaves huge downstream value on the table:

| What competitors *cannot* do without owning the ledger | Why IsaFlow can |
|---|---|
| Click a trial-balance line → drill to the slip that evidences it | GL, AP, AR, bank, and document storage are all in-tenant |
| 3-way / 4-way match at line level (PO → GRN → invoice → payment) | `purchase_orders`, `goods_received_notes`, `supplier_invoices`, `bank_transactions` already linked by FK |
| Bank-first inverted workflow (post from bank swipe, attach evidence later) | Owns bank feed + rules + AP + journal posting |
| Continuous VAT201 / EMP501 / IT3(b) that is always reconciled | Owns both sides of the VAT, payroll, and dividend ledgers |
| Cross-tenant supplier intelligence + cohort fraud detection | Multi-tenant by design, with RLS-safe shared reference data |
| "Missing invoice" auto-chase via WhatsApp / email | Owns the supplier master + communication channel |

SA bookkeepers currently split their stack: Dext for capture (R400/user/month), Xero/Sage for ledger (R600/month), separate VAT/SARS tooling, separate WhatsApp chase, separate audit packaging. This PRD consolidates all of that into IsaFlow and ships three capabilities **nobody else has**: evidence-first drill-through, native 3/4-way match, and bank-first agentic AP.

---

## 2. What Already Exists

IsaFlow is ~60% of the way there. The extraction engine is built; the ledger integration is built; the missing pieces are capture channels, the supplier-rules layer, predictive workflow, and the cross-cutting evidence graph.

| Component | Status | Path |
|---|---|---|
| VLM OCR with SA prompt (invoice / receipt / credit note / PO / delivery note / statement) | ✅ Shipped | `services/bank/vlmInvoiceService.ts`, `vlmCore.ts` |
| Receipt → GL journal builder | ✅ Shipped | `services/bank/receiptToJournalService.ts` |
| AI invoice pipeline (supplier match, invoice build, approval route, confidence) | ✅ Shipped | `services/core/aiInvoicePipelineService.ts`, `ai-invoice-pipeline.ts` API |
| Bank transactions + import + rules + AI categorise | ✅ Shipped | `services/bank/*`, `bank-rules-*.ts`, `ai-categorize.ts` |
| Bank match candidates (fuzzy match bank line → invoices) | ✅ Shipped | `services/bank/bankMatchCandidatesService.ts` |
| Bank allocation + journal posting | ✅ Shipped | `services/bank/bankAllocationService.ts` |
| Document storage table with VLM extractions | ✅ Shipped | `documents`, `document_extractions` |
| PO / GRN / supplier invoice schema | ✅ Shipped | `purchase_orders`, `po_items`, `goods_received_notes`, `grn_items`, `supplier_invoices`, `supplier_invoice_items` |
| Approval workflow engine | ✅ Shipped | `approval_requests`, `approval_rules` |
| Anomaly scan + duplicate candidates (basic) | ⚠️ Partial | `anomaly-scan.ts` — exists, not surfaced on capture |
| Line-item extraction **into `supplier_invoice_items`** | ❌ Not wired | VLM returns line items, pipeline only writes header |
| Email-inbox capture channel (unique address per company) | ❌ Missing | — |
| PWA / mobile slip capture | ❌ Missing | — |
| WhatsApp Business inbound | ❌ Missing | — |
| Supplier coding defaults + auto-publish toggle | ❌ Missing | Bank rules exist; no equivalent for suppliers |
| Bank statement PDF → transactions | ❌ Missing | CSV import only |
| Supplier statement reconciliation | ❌ Missing | — |
| Mirror-inbox IMAP / Gmail / M365 | ❌ Missing | — |
| Expected-invoice / missing-invoice engine | ❌ Missing | — |
| Evidence-first ledger (`source_document_id` + hash on every posting) | ❌ Missing | `gl_journal_entries` has `source_ref` text only |
| TB / P&L / BS drill-to-document | ❌ Missing | Drills to JE but not to source slip |
| Cross-tenant supplier embedding / fraud graph | ❌ Missing | — |
| Employee expense claims + mileage | ❌ Missing | No module |
| SARS VAT-vendor lookup on capture | ❌ Missing | — |
| Audit-trail-as-a-product export | ❌ Missing | Audit log exists, not packaged |

---

## 3. Strategic Bet

> **Dext is a capture tool married to an accounting system. IsaFlow is an accounting system where capture is a natural consequence of posting. Invert the metaphor; own the graph.**

Build priorities follow from this inversion. The highest-asymmetry moves are the ones a pure-capture vendor **structurally cannot copy** — they require owning the ledger. Those are the anchors of this PRD. Feature parity with Dext (email inbox, PWA, supplier rules) is table-stakes and comes first because we need a capture channel before the clever stuff has inputs.

---

## 4. Data Model Changes

### 4.1 Evidence-First Ledger

Every journal entry, bank allocation, and AP posting carries a cryptographic link to its source document. This is the foundation of drill-through and the audit-trail product.

```sql
-- Strengthen the existing link on journal entries.
ALTER TABLE gl_journal_entries
  ADD COLUMN IF NOT EXISTS source_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS source_document_hash text,       -- SHA-256 of original file
  ADD COLUMN IF NOT EXISTS extraction_confidence numeric(5,4), -- 0..1 from VLM
  ADD COLUMN IF NOT EXISTS posting_agent text;              -- 'human' | 'ai:v<version>' | 'rule:<ruleId>'

-- Every journal LINE can also carry evidence when a line maps to a single
-- line of a multi-line document (line-level VAT, line-level cost-centre).
ALTER TABLE gl_journal_lines
  ADD COLUMN IF NOT EXISTS source_document_line_id uuid;   -- nullable; references supplier_invoice_items, customer_invoice_items, etc.

CREATE INDEX IF NOT EXISTS idx_gl_je_source_doc ON gl_journal_entries(source_document_id);
CREATE INDEX IF NOT EXISTS idx_supplier_inv_source_doc ON supplier_invoices(source_document_id);
```

Every write path (AP post, AR post, bank allocation, expense claim post, payroll post, fixed-asset depreciation) must set `source_document_id` OR `posting_agent='human'` where no document applies. CI lint rule enforces it.

### 4.2 Capture Channels

```sql
CREATE TABLE capture_inboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel text NOT NULL,              -- 'email' | 'pwa' | 'whatsapp' | 'imap_mirror' | 'api'
  address text NOT NULL,              -- e.g. 'demo-a7f3@inbox.isaflow.co.za', WhatsApp number, IMAP user
  is_active boolean NOT NULL DEFAULT true,
  allowed_sender_domains text[],      -- optional whitelist for email channels
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, channel, address)
);

CREATE TABLE capture_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  inbox_id uuid REFERENCES capture_inboxes(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  channel text NOT NULL,              -- denormalised for query speed
  sender text,                        -- email from, whatsapp MSISDN, userId for PWA
  raw_payload_url text,               -- pointer to stored original (S3)
  status text NOT NULL DEFAULT 'received',  -- received | extracting | extracted | posted | discarded | failed
  document_id uuid REFERENCES documents(id),
  extraction_id uuid,
  error text,
  posted_by text,                     -- 'human:<userId>' | 'agent:<version>' | 'rule:<id>'
  posted_at timestamptz
);
```

### 4.3 Supplier Coding Rules (auto-publish)

Mirrors the existing `bank_rules` table but for suppliers.

```sql
CREATE TABLE supplier_coding_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  default_gl_account_id uuid REFERENCES gl_accounts(id),
  default_vat_code text,
  default_cost_centre_id uuid,
  default_project_id uuid,
  auto_publish boolean NOT NULL DEFAULT false,
  auto_publish_max_amount numeric(18,2),  -- cap
  auto_publish_min_confidence numeric(5,4) DEFAULT 0.95,
  require_po_match boolean NOT NULL DEFAULT false,  -- if true, blocks auto-publish without matched PO
  learned_from_last_correction_at timestamptz,
  learned_sample_count int NOT NULL DEFAULT 0,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, supplier_id)
);

CREATE TABLE supplier_coding_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  supplier_invoice_id uuid,
  gl_account_id uuid,
  vat_code text,
  cost_centre_id uuid,
  project_id uuid,
  posted_at timestamptz NOT NULL DEFAULT now(),
  posted_by text NOT NULL
);
-- Rolling lookup: "what did this supplier get coded to last 20 times?"
-- Feeds both the learning loop and the drift-detection alert.
```

### 4.4 Supplier Expectation Engine

```sql
CREATE TABLE supplier_expectations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  cadence text NOT NULL,              -- 'monthly' | 'quarterly' | 'annual' | 'irregular'
  expected_day_of_month int,          -- 1..31 (null for irregular)
  expected_amount numeric(18,2),      -- trimmed mean of last 6 invoices
  amount_stddev numeric(18,2),
  last_invoice_date date,
  last_invoice_amount numeric(18,2),
  sample_size int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'learning',  -- learning | locked | paused
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, supplier_id)
);

CREATE TABLE expected_invoice_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  expected_by date NOT NULL,
  expected_amount numeric(18,2),
  status text NOT NULL DEFAULT 'pending',  -- pending | chased | resolved | dismissed
  chased_at timestamptz,
  chase_method text,                  -- 'email' | 'whatsapp'
  resolved_invoice_id uuid REFERENCES supplier_invoices(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### 4.5 Cross-Tenant Supplier Graph (shared)

Lives in a `platform_shared` schema, owned by the platform, **not** scoped to a tenant. Only the structure is shared, never the tenant data.

```sql
CREATE SCHEMA IF NOT EXISTS platform_shared;

CREATE TABLE platform_shared.supplier_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL,       -- "Eskom Holdings SOC Ltd"
  vat_registration text,              -- "4000015215" (public SARS data)
  country_code text NOT NULL DEFAULT 'ZA',
  invoice_layout_embedding vector(768),   -- from VLM doc-structure embed
  canonical_categories text[],        -- e.g. ['5450 Electricity']
  known_bank_accounts text[],         -- for fraud signal: unexpected bank account = flag
  fraud_score numeric(5,4) DEFAULT 0,
  observations_count int NOT NULL DEFAULT 0,  -- # of tenants that have seen this template
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_shared.fraud_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_type text NOT NULL,          -- 'vat_mismatch' | 'bank_change' | 'email_spoof' | 'layout_anomaly'
  supplier_template_id uuid REFERENCES platform_shared.supplier_templates(id),
  evidence jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);
```

**Privacy stance:** `supplier_templates` contains only **public** data (legal name, public VAT nr, document-structure embedding). No amounts, no counterparty data, no tenant IDs. Opt-in by default via the company's `share_anonymised_signals` flag; default `true` on signup with a clear one-click opt-out.

### 4.6 Employee Expense Claims

```sql
CREATE TABLE expense_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  employee_id uuid REFERENCES employees(id),
  claim_number text NOT NULL,
  claim_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft',  -- draft | submitted | approved | rejected | posted
  total_amount numeric(18,2) NOT NULL DEFAULT 0,
  total_vat numeric(18,2) NOT NULL DEFAULT 0,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  posted_je_id uuid REFERENCES gl_journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE expense_claim_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
  line_date date NOT NULL,
  description text,
  merchant text,
  amount numeric(18,2) NOT NULL,
  vat_amount numeric(18,2) NOT NULL DEFAULT 0,
  vat_code text,
  gl_account_id uuid REFERENCES gl_accounts(id),
  cost_centre_id uuid,
  project_id uuid,
  source_document_id uuid REFERENCES documents(id),
  km_travelled numeric(8,2),          -- mileage line
  km_rate numeric(6,2),               -- SARS 2026 rate = 4.84/km prescribed
  mileage_route jsonb                 -- GPS trace from PWA (optional)
);
```

### 4.7 Bank Statement & Supplier Statement Reconciliation

```sql
CREATE TABLE bank_statement_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  source_document_id uuid NOT NULL REFERENCES documents(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  opening_balance numeric(18,2),
  closing_balance numeric(18,2),
  row_count int NOT NULL,
  imported_count int NOT NULL DEFAULT 0,
  duplicate_count int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'extracted',  -- extracted | reviewing | committed | rolled_back
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE supplier_statement_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  statement_date date NOT NULL,
  supplier_balance numeric(18,2) NOT NULL,    -- "you owe us"
  isaflow_balance numeric(18,2) NOT NULL,     -- supplier ledger total
  variance numeric(18,2) NOT NULL,
  status text NOT NULL DEFAULT 'unreconciled',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE supplier_statement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id uuid NOT NULL REFERENCES supplier_statement_reconciliations(id) ON DELETE CASCADE,
  statement_date date,
  reference text,
  description text,
  debit numeric(18,2) NOT NULL DEFAULT 0,
  credit numeric(18,2) NOT NULL DEFAULT 0,
  matched_supplier_invoice_id uuid,
  match_confidence numeric(5,4),
  mismatch_reason text                -- 'missing_in_isaflow' | 'missing_in_statement' | 'amount_diff' | 'date_diff'
);
```

---

## 5. Services & APIs

### 5.1 New services (`src/modules/accounting/services/capture/`)

| Service | Responsibility |
|---|---|
| `captureInboxService.ts` | Mint email address, WhatsApp number, PWA tokens; register channels |
| `inboundEmailService.ts` | Postmark/SES inbound webhook handler; extract attachments, enqueue |
| `inboundWhatsAppService.ts` | Twilio WABA inbound; media + text → `capture_events` |
| `pwaUploadService.ts` | Direct browser upload; offline queue reconciliation |
| `imapMirrorService.ts` | OAuth Gmail/M365; watch for invoice attachments; privacy filters |
| `captureRouterService.ts` | Single entry point: event → documents → VLM → pipeline |
| `supplierRulesService.ts` | CRUD + learning loop (update rule on each human correction) |
| `autoPublishGateService.ts` | Decide: route to inbox vs auto-post (confidence × rule × amount × duplicate check × fraud check) |
| `expectationEngineService.ts` | Nightly job: recompute cadence + open alerts for missing invoices |
| `missingInvoiceChaseService.ts` | Compose + send chase emails/WhatsApp from the client's domain |
| `bankStatementOcrService.ts` | VLM prompt for bank-statement PDFs; extract rows; dedupe against existing `bank_transactions` |
| `supplierStatementReconService.ts` | Match statement lines to `supplier_invoices`; produce variance report |
| `evidenceGraphService.ts` | Build drill-path: TB row → JE → source doc → original file |
| `supplierGraphService.ts` | Embed new supplier templates; query cross-tenant for fraud signals |
| `expenseClaimService.ts` | CRUD, submit, approve, post |
| `mileageService.ts` | GPS trace → distance → SARS rate lookup → expense line |
| `sarsVatVendorService.ts` | Call SARS VAT Vendor Search API (public) on supplier create / on capture |
| `auditTrailExportService.ts` | Package full evidence chain per period as signed PDF + index |

### 5.2 New endpoints (`pages/api/accounting/capture/`)

```
POST   /capture/inbound/email       (Postmark webhook)
POST   /capture/inbound/whatsapp    (Twilio webhook)
POST   /capture/upload              (PWA multipart)
GET    /capture/inbox               (list pending)
POST   /capture/:id/post            (human confirms)
POST   /capture/:id/discard
POST   /capture/:id/route-approval
GET    /capture/inbox/address       (show + regenerate unique email)

GET    /supplier-rules
POST   /supplier-rules
PATCH  /supplier-rules/:id
DELETE /supplier-rules/:id

GET    /supplier-expectations
POST   /supplier-expectations/recompute   (manual trigger)
GET    /expected-invoice-alerts
POST   /expected-invoice-alerts/:id/chase

POST   /bank-statements/extract     (upload PDF)
POST   /bank-statements/:id/commit  (merge into bank_transactions)

POST   /supplier-statements/extract
GET    /supplier-statements/:id

GET    /evidence/trial-balance/:accountId   (drill: TB row → JEs → docs)
GET    /evidence/je/:jeId                    (JE → doc → file)

GET    /expense-claims
POST   /expense-claims
POST   /expense-claims/:id/submit
POST   /expense-claims/:id/approve
POST   /expense-claims/:id/post
POST   /expense-claims/mileage/trip          (GPS trace → line)

POST   /audit-trail/export                   (period → signed PDF)

GET    /fraud/signals                        (tenant-visible alerts)
```

### 5.3 Modifications to existing services

- `aiInvoicePipelineService.ts` — after successful header post, write `supplier_invoice_items` from `extraction.lineItems`; link each line back to extracted line.
- `bankAllocationService.ts` — on every allocation write `source_document_id` to the resulting JE.
- `journalEntryPostingService.ts` — enforce `source_document_id OR posting_agent='human'` constraint; backfill stamp existing JEs where possible.
- `anomaly-scan.ts` — augment with cross-tenant fraud graph lookup; surface inline in capture inbox, not as a scheduled scan.

---

## 6. UI Pages

### 6.1 New

| Route | Purpose |
|---|---|
| `/accounting/capture/inbox` | Unified inbox across all channels; extract fields on right, actions: Post / Approve / Discard |
| `/accounting/capture/settings` | Email address, WhatsApp number, PWA QR, IMAP connections, auto-publish toggles |
| `/accounting/capture` (PWA) | Phone camera capture, offline queue, one-tap submit |
| `/accounting/suppliers/:id/rules` | Per-supplier coding defaults + auto-publish toggle |
| `/accounting/suppliers/expectations` | Expected vs received calendar; chase history |
| `/accounting/bank/statements/import-pdf` | Drop PDF → extract → review rows → commit |
| `/accounting/ap/supplier-statements` | List + upload + reconcile |
| `/accounting/expenses/claims` | Employee claim list + detail |
| `/accounting/expenses/claims/new` | Create claim from captured docs |
| `/accounting/expenses/mileage` | Trip tracker + history |
| `/accounting/audit-trail` | Period picker + "Export signed evidence pack" |
| `/accounting/fraud/signals` | Tenant's cross-tenant fraud alerts |

### 6.2 Modifications

- **Trial Balance / Income Statement / Balance Sheet:** existing drill-down gains an "Evidence" tab — every JE shows its source document thumbnail + extraction fields.
- **Supplier Invoice form:** when opened from the inbox, all fields pre-filled from extraction, line items populated, supplier rule indicator visible ("Applied rule: 'Telkom → 5400 Telecommunications, auto-publish').
- **Bank Transactions:** new column "Expected evidence" on unallocated lines; shows `[predicted supplier] — invoice not yet received`.
- **Dashboard:** "Capture inbox (N pending)", "Expected invoices overdue (N)", "Fraud signals (N)" widgets.

---

## 7. Phased Delivery

Each phase is independently shippable and produces user-visible value. Prior phases unlock the value of later ones.

### Phase 1 — Capture channels (2 weeks) `P0`

- Email inbox per company (`<code>@inbox.isaflow.co.za`), Postmark/SES inbound webhook, attachment extraction
- PWA `/accounting/capture` — camera input, offline queue, bg-sync
- `capture_inboxes`, `capture_events` tables + inbox UI
- Route everything through the existing `vlmInvoiceService` → `aiInvoicePipelineService`
- **Wire line-item extraction into `supplier_invoice_items`** (this is a 2-day task on the existing pipeline, huge downstream value)

**Exit criteria:** bookkeeper forwards 50 slips to a unique email address and sees them in an inbox with extracted fields; half can be one-click-posted.

### Phase 2 — Evidence-first ledger (1 week) `P0`

- Migration: add `source_document_id`, hash, confidence, `posting_agent` to `gl_journal_entries` + `gl_journal_lines`
- Backfill existing JEs from `source_ref` where resolvable
- `evidenceGraphService` + drill-through endpoints
- TB / P&L / BS drill UI — click amount → see slip
- CI lint rule to enforce the new invariant on write paths

**Exit criteria:** on any reports page, click any amount, see the supporting document in ≤2 clicks.

### Phase 3 — Supplier rules + auto-publish + fraud gate (1–2 weeks) `P0`

- `supplier_coding_rules`, `supplier_coding_history`
- Learning loop: every human correction updates the rule
- `autoPublishGateService` — decide inbox vs auto-post
- SARS VAT Vendor Search on supplier creation
- Duplicate detection (hash of VAT + invoice nr + total; fuzzy match on name + date + amount)

**Exit criteria:** after coding 5 invoices from Telkom, the 6th arrives from email and posts automatically; the 7th with an anomalous amount routes for review.

### Phase 4 — Native 3/4-way match (2 weeks) `P1`

- Line-level match: PO ↔ GRN ↔ Invoice (exists, not wired)
- Add Payment leg: Invoice ↔ Bank Transaction (exists via `bankMatchCandidates`, formalise)
- Mismatch diff UI (qty / price / tolerance rules)
- Tolerance config per supplier rule

**Exit criteria:** overbilling or price drift is caught automatically; matched-4-way invoices auto-post with one-click confirm.

### Phase 5 — Bank-first inverted workflow (2 weeks) `P1`

- When a bank transaction lands without an invoice match, agent predicts supplier/GL/VAT/CC from history
- Post *provisional* JE with `posting_agent='ai-provisional:<version>'` and `needs_evidence=true`
- Attach evidence on later invoice/slip arrival; flip `posting_agent='ai-evidenced'`
- Daily chase job: provisional entries > 5 days old → email/WhatsApp user for slip

**Exit criteria:** card swipe at Shell appears as a posted entry within 5 minutes; the photo of the slip later auto-attaches without any human coding action.

### Phase 6 — Supplier expectation engine + missing-invoice chase (1–2 weeks) `P1`

- `supplier_expectations` nightly cron to learn cadence
- `expected_invoice_alerts` daily cron to find gaps
- Chase composer (email first; WhatsApp in Phase 8)
- Dashboard widget

**Exit criteria:** on day 29 of the month, if no Eskom invoice received, system has emailed Eskom automatically from the client's domain and logged the chase.

### Phase 7 — Bank & supplier statement PDF reconciliation (2 weeks) `P1`

- VLM prompt for bank statement PDFs; dedupe against `bank_transactions`
- VLM prompt for supplier statements; line match to `supplier_invoices`
- Variance UI + "missing-in-IsaFlow" / "missing-in-statement" / "amount-diff" flags

**Exit criteria:** upload a month's ABSA PDF; system commits 95%+ rows correctly and flags the rest. Upload a supplier statement; system matches 90%+ lines and highlights the gaps.

### Phase 8 — WhatsApp inbound + conversational ledger (1 week, requires Phase 1) `P1`

- Twilio WhatsApp Business
- Inbound photo + caption → `capture_events`
- Inbound text command ("paid R850 Shell, company card") → structured provisional entry
- Outbound chase messages from Phase 6

**Exit criteria:** business owner sends a photo of a slip via WhatsApp and receives "Posted to Motor Expenses R850 (VAT R113)" as a reply within 10s.

### Phase 9 — Mirror inbox (IMAP / Gmail / M365) (2 weeks) `P2`

- OAuth Gmail + M365
- Background watcher for invoice-shaped attachments
- Per-sender allow/deny list

**Exit criteria:** client connects their inbox once; invoices from known suppliers auto-appear in the capture inbox without forwarding.

### Phase 10 — Expense claims + mileage (2 weeks) `P2`

- Claims CRUD, submit, approve, post (reuse `approval_requests`)
- Mileage via PWA GPS trace; SARS rate lookup
- Integration with payroll for reimbursement

**Exit criteria:** an employee submits a claim with three captured slips + one mileage trip; approver clicks approve; entry posts to GL with all four evidence links.

### Phase 11 — Cross-tenant supplier graph + cohort fraud (3 weeks) `P2`

- `platform_shared.supplier_templates` + embeddings
- Per-tenant opt-in flag
- Fraud signal UI
- Nightly anomaly scan across the graph

**Exit criteria:** a new tenant signing up gets 99% extraction accuracy on the top 200 SA suppliers from day one without sharing any tenant data.

### Phase 12 — Audit-trail-as-a-product (1 week) `P2`

- Period-export bundler: JE → docs → extraction metadata → signed PDF
- Auditor portal (read-only, scoped)
- Billing integration (charge per client-period audited)

**Exit criteria:** auditor reviews a client's full year in <2 hours using the evidence bundle; IsaFlow books the per-client audit fee.

**Total estimated effort:** 18–22 engineer-weeks, with Phase 1–3 (core loop) shippable in 5 weeks.

---

## 8. Success Metrics

| Metric | Baseline | Target (12 weeks post-launch) |
|---|---|---|
| % supplier invoices captured without manual form entry | <5% | ≥80% |
| Time from slip photo → posted entry (median) | n/a | <30s |
| % bank transactions auto-coded before invoice arrives (Phase 5) | 0% | ≥60% |
| Duplicate invoice postings caught before payment | n/a | ≥99% |
| % month-ends where supplier statements fully reconcile on first pass | <20% | ≥70% |
| Audit-trail-as-a-product ARR | R0 | R250k+ (50 auditor-firm clients × ~R5k/firm/month) |
| Churn of Dext/Hubdoc after cutover offer | n/a | ≥40% cutover within 90 days |
| Capture-inbox MAU / total MAU | 0% | ≥75% |

---

## 9. Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| VLM extraction accuracy regresses on long-tail suppliers | Med | High | Ship cohort graph (Phase 11) to bootstrap common SA suppliers; hold confidence gate at 0.95; manual review path always available |
| Auto-publish posts bad data to the GL | Low | Very High | Confidence + rule + duplicate + fraud-signal gate; posting_agent stamp on every JE; one-click un-post with full reversal |
| POPIA issues with mirror inbox / cross-tenant graph | Med | High | Read-only IMAP, explicit consent, one-click disconnect; shared graph contains only public data + embeddings; external PIA before Phase 9 & 11 |
| WhatsApp Business API gets rate-limited at scale | Med | Med | Queue + retry with exponential backoff; Twilio business verification; fall back to SMS |
| SARS VAT Vendor Search API is rate-limited / unavailable | High | Low | Cache results 30 days; graceful degradation (warn, don't block) |
| Phase-6 chase emails damage customer-supplier relationships | Med | Med | Opt-in per supplier; chase only after X days; customer can always preview + approve the chase text before send |
| Fraud graph false-positives block real suppliers | Low | High | Tenant-visible signal with "not fraud" dismiss button; signals are advisory, never blocking, until Phase 11 maturity |
| Email inbox abuse (inbound spam) | Med | Low | Allow-list per company; per-sender rate limits; discard on no attachment |
| Evidence-first ledger migration breaks existing JEs | Low | Very High | All new columns nullable; backfill in background job; CI check for write paths; no changes to read paths |

---

## 10. Open Questions

1. **Auto-publish default:** should new companies opt in by default (aggressive) or opt in per-supplier (conservative)? Recommendation: conservative. Bookkeepers trust an explicit "enable for this supplier" click.
2. **Chase wording:** do we let customers edit chase templates, or own the copy for consistency? Recommendation: ship default SA-tone templates, allow edit at company level only.
3. **WhatsApp number:** one IsaFlow-owned number for all tenants (costs R500/mo, low per-tenant setup) or per-tenant Twilio sub-account (R300/mo each, cleaner audit)? Recommendation: shared number with company-code routing; upgrade path to dedicated per-tenant exists.
4. **Cross-tenant graph opt-out default:** on or off? Recommendation: on (but clearly disclosed), matching Stripe Radar's network-effect model; one-click off in company settings.
5. **Auditor portal pricing model:** per-firm monthly, per-client-period, or per-review? Recommendation: per-client-period flat fee (R250/client/year audited), sellable as an add-on to the accountant's IsaFlow plan.
6. **PWA vs native app:** does SA mobile network quality demand a true native app for offline capture? Recommendation: start PWA (ships in 3 days), measure capture success rates, only native if <90% upload success on 3G/LTE.

---

## 11. Out of Scope (for this PRD)

- **Supplier-portal scraping** (Eskom/Telkom/Vodacom web portals). Fragile, legally grey; superseded by Phase 9 mirror inbox, which covers the same need without scraping.
- **Native iOS/Android apps.** PWA covers the use case; reconsider after 6 months of usage telemetry.
- **Full ERP-grade procurement workflow** (requisitions, multi-level PO approvals beyond what `approval_requests` already gives). Scope remains AP + capture, not procurement.
- **Customer-side (AR) evidence capture.** The same evidence-first ledger infrastructure applies to customer invoices; ship that as PRD-06 once this stabilises.
- **Blockchain/on-chain audit anchoring.** Interesting for the audit-trail product but materially beyond scope; explore in PRD-06.

---

## 12. Dependencies

- Postmark or SES inbound (email channel) — contract + DNS
- Twilio WhatsApp Business API — account + sender number verification
- SARS VAT Vendor Search API — free, public, rate-limited
- `pgvector` extension on the platform_shared schema for supplier embeddings
- Supabase storage bucket for raw captured files (exists)
- Existing `vlmInvoiceService` + `aiInvoicePipelineService` (shipped)
- Existing `approval_requests` engine (shipped)
