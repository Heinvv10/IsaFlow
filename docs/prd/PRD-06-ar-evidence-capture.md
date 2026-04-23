# PRD-06: AR Evidence Capture

**Status:** `DRAFT`
**Priority:** P0 — Symmetric counterpart to PRD-05. Once AR is on the evidence-first ledger too, every posting in the company has a traceable source document and every receipt on the bank feed can auto-reconcile to its invoice without human intervention.
**Source specs:** PRD-05 §11 Out-of-scope ("Customer-side AR evidence capture"), SA accountant workflow audit (2026-04-15 through 2026-04-23), competitive scan of Xero Ask, QuickBooks AR, Chaser, Upflow, Invoiced.com.
**Related modules:** AR (`customer_invoices`, `customer_payments`), Banking (`bank_transactions`, `bankMatchCandidatesService`), Documents (`captured_documents`), Practice (client portal), PRD-05 evidence-graph infra.

---

## 1. Problem Statement

PRD-05 closed the loop on **AP evidence**: every supplier invoice carries a `source_document_id`, every GL line traces back to the extracted slip, and auditors can see the original document behind any number on the trial balance. The AR side of the ledger is half that story — we **emit** invoices but we don't treat our own outbound PDFs, credit notes, delivery notes, or statements as first-class evidence, and we have no counterparty signal (customer-read receipts, portal views, dispute flags) to feed back into collections or revenue recognition.

The gap shows up in three concrete places:

1. **Drill-through is asymmetric.** Click a TB row in the Revenue account and you get the JE → customer invoice. But the invoice itself has no stored PDF — it was re-rendered on demand from the line items. If the client changed the template three months ago, the "evidence" the auditor sees today doesn't match the document the customer actually received.
2. **Receipt matching is blind to the customer's side.** When ABSA shows a R12,450 EFT in, we fuzzy-match against open invoices. We don't know the customer already viewed the invoice three weeks ago and paid reference `INV-2024-8843` — the payment reference sits on the bank statement but we never link it back to the invoice's read-receipt or portal access log.
3. **Disputes live in someone's inbox.** When a customer emails "line 3 is wrong, we'll pay the rest", the AR ledger doesn't know. AR aging shows the full amount 60+ days, collection reminders keep going out, and the bookkeeper finds out at quarter-end.

Three unlocks:

| What nobody else offers when AR evidence lives next to the ledger | Why IsaFlow can |
|---|---|
| TB drill-to-PDF of the exact invoice the customer received | Owns rendering, storage, and the hash seal (PRD-05 Phase 12 infra) |
| Bank receipt → invoice auto-match via portal-access log + payment reference + embedding similarity | Owns bank feed + portal + document embeddings (Phase 11 graph) |
| Dispute-aware collections: stop chasing disputed lines, age them separately, surface them on the next AFS review | Owns `customer_invoice_items`, `approval_requests`, and the WIP / practice workflow |

SA bookkeepers currently patch this by emailing reminders from Gmail, tracking disputes in a spreadsheet, and reconciling receipts by eyeballing the customer name in the bank description. PRD-06 folds all of that into the ledger.

---

## 2. What Already Exists

PRD-05's evidence-first infrastructure is fully reusable for AR — only the write sites and the capture channels differ.

| Component | Status | Path |
|---|---|---|
| `captured_documents` + `raw_bytes_sha256` + Supabase Storage pointer | ✅ Shipped (PRD-05 Phase 1) | `src/lib/documentStorage.ts` |
| Evidence-first ledger columns on `gl_journal_entries` / `gl_journal_lines` | ✅ Shipped (PRD-05 Phase 2) | mig-409 |
| Drill-through: TB row → JE → source doc | ✅ Shipped | `evidenceGraphService.ts` |
| Bank-match candidates for customer payments | ⚠️ Partial | `bankMatchCandidatesService.ts` — matches on amount + date, no customer-side signal |
| Customer-invoice PDF rendering | ✅ Shipped | `pdf-templates/customer-invoice.ts` |
| Customer-invoice storage of rendered PDF | ❌ Missing | PDFs are re-rendered on demand, never snapshotted |
| Customer portal (viewing invoices, paying) | ⚠️ Partial | Signum integration exists for AFS; no invoice-view portal |
| Dispute flag on `customer_invoice_items` | ❌ Missing | — |
| Payment-reference → invoice auto-match | ❌ Missing | — |
| AR aging segregation by dispute status | ❌ Missing | — |
| Read-receipt / portal-access audit log | ❌ Missing | — |
| Sent-folder mirror (your outbound emails → capture) | ❌ Missing | PRD-05 mirror inbox is inbound-only |
| Statement / dunning letter generation as first-class docs | ❌ Missing | Reminders send via email, no document record |

---

## 3. Strategic Bet

> **PRD-05 asked: what did your supplier send you? PRD-06 asks: what did your customer actually see? Both answers live in the same evidence graph. When a payment arrives, the ledger already knows which line it pays.**

Two sharp consequences:

- **Receipt auto-match jumps from ~70% to >95%** when the portal access log + payment reference + document embedding vote together. Xero / Sage can't touch this because they see only the bank side.
- **Collections stops being a bludgeon.** Disputed lines age separately; reminders skip them. The accountant opens one dispute queue (not 40 customer emails) to resolve. Churn on overdue accounts drops because the annoyance of being chased for something you already disputed goes away.

Feature parity with Chaser / Upflow (dunning sequences, customer portal, dispute queue) is table-stakes; it comes first. The ledger-native payoffs (TB drill, receipt match, dispute-aware aging) are the moat.

---

## 4. Data Model Changes

### 4.1 Invoice-as-Evidence

```sql
-- Snapshot the PDF at approval time so the document the auditor sees
-- in 3 years is the one the customer got.
ALTER TABLE customer_invoices
  ADD COLUMN IF NOT EXISTS rendered_pdf_storage_path text,
  ADD COLUMN IF NOT EXISTS rendered_pdf_sha256 text,
  ADD COLUMN IF NOT EXISTS rendered_pdf_rendered_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_document_id uuid REFERENCES captured_documents(id);

CREATE INDEX IF NOT EXISTS idx_cust_inv_source_doc
  ON customer_invoices(source_document_id) WHERE source_document_id IS NOT NULL;

-- Invoice PDFs ARE captured_documents rows — the pipeline flips on send:
--   1. render PDF
--   2. upload to storage bucket = 'customer-invoices'
--   3. insert captured_documents row with document_type = 'sent_invoice'
--   4. stamp customer_invoices.source_document_id + rendered_pdf_*
```

### 4.2 Portal Access Log

```sql
CREATE TABLE customer_invoice_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_invoice_id uuid NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  ip_address inet,                    -- anonymised after 30 days
  user_agent text,
  view_source text,                   -- 'portal' | 'tracking_pixel' | 'pdf_link' | 'api'
  session_token text,                 -- one-way hash of the customer's portal session
  response_time_ms int                -- latency signal for fraud screening
);

CREATE INDEX idx_cust_inv_views ON customer_invoice_views(customer_invoice_id, viewed_at DESC);
CREATE INDEX idx_cust_inv_views_session ON customer_invoice_views(session_token)
  WHERE session_token IS NOT NULL;

-- Aggregate materialised view for the AR list UI so we can show
-- "last viewed 2 days ago" without a per-row subquery.
CREATE MATERIALIZED VIEW customer_invoice_view_summary AS
SELECT customer_invoice_id,
       company_id,
       MAX(viewed_at) AS last_viewed_at,
       COUNT(*)      AS view_count,
       COUNT(DISTINCT session_token) FILTER (WHERE session_token IS NOT NULL) AS distinct_sessions
FROM customer_invoice_views
GROUP BY customer_invoice_id, company_id;

CREATE UNIQUE INDEX idx_cust_inv_view_summary
  ON customer_invoice_view_summary(customer_invoice_id);
```

### 4.3 Dispute Workflow

```sql
CREATE TABLE customer_invoice_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_invoice_id uuid NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  customer_invoice_line_id uuid REFERENCES customer_invoice_items(id),  -- null = whole-invoice dispute
  reason text NOT NULL,
  raised_by text NOT NULL,            -- 'customer:<portalSessionId>' | 'user:<userId>' | 'email:<from>'
  raised_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','withdrawn','rejected')),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  resolution_note text,
  disputed_amount numeric(18,2) NOT NULL,
  source_document_id uuid REFERENCES captured_documents(id),  -- customer's email / rejection letter
  UNIQUE(customer_invoice_id, customer_invoice_line_id, status)
    DEFERRABLE INITIALLY DEFERRED   -- allows resolve → re-raise
);

-- Separate aging bucket for disputed amounts. AR aging queries gain a
-- COALESCE(disputed_amount, 0) column so collections UI can show
-- "R8,450 disputed" alongside the overdue total.
CREATE INDEX idx_cust_inv_disputes_company
  ON customer_invoice_disputes(company_id, status, raised_at DESC);
CREATE INDEX idx_cust_inv_disputes_invoice
  ON customer_invoice_disputes(customer_invoice_id, status);
```

### 4.4 Receipt → Invoice Auto-Match

```sql
-- Extend bank_match_candidates with AR-specific signals
ALTER TABLE bank_match_candidates
  ADD COLUMN IF NOT EXISTS portal_view_boost numeric(4,3) DEFAULT 0,      -- +0.1 if viewed in last 30d
  ADD COLUMN IF NOT EXISTS payment_reference_exact boolean DEFAULT false, -- full INV-* hit
  ADD COLUMN IF NOT EXISTS payment_reference_partial boolean DEFAULT false;

-- A stored reference ↔ invoice_number index speeds up the exact-match lookup.
CREATE INDEX IF NOT EXISTS idx_customer_invoices_number_active
  ON customer_invoices(company_id, invoice_number)
  WHERE status IN ('approved','sent','partially_paid');
```

### 4.5 Outbound-Channel Capture (sent-folder mirror)

```sql
-- Mirror of PRD-05's inbound mirror, but watching the Sent folder.
-- Captures outbound emails (invoice PDFs, statements, dunning letters)
-- as first-class captured_documents so there's a single evidence graph
-- on both sides.
CREATE TABLE sent_mirror_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('gmail','m365','imap')),
  display_name text NOT NULL,
  account_email text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','disconnected','error')),
  oauth_refresh_token_enc text,
  imap_host text, imap_port int, imap_use_tls boolean DEFAULT true,
  imap_username text, imap_password_enc text,
  sent_folder text NOT NULL DEFAULT 'Sent',
  scan_cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  scan_interval_minutes int NOT NULL DEFAULT 10,
  last_scan_at timestamptz,
  last_success_at timestamptz,
  messages_captured_total int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, account_email)
);

-- When a sent email contains an attachment whose sha256 already exists
-- in captured_documents AND the sender matches this tenant's sent-mirror
-- account, we link it to the outbound customer_invoice rather than
-- creating a new inbound capture event.
```

### 4.6 Dunning Letters as Evidence

```sql
-- Every reminder / statement / legal letter sent to a customer becomes a
-- captured_documents row with document_type = 'dunning' | 'statement' | 'demand'.
-- Dunning policy per company; templates per customer.
CREATE TABLE dunning_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  days_overdue_min int NOT NULL,
  days_overdue_max int,
  subject_template text NOT NULL,
  body_template text NOT NULL,
  tone text NOT NULL DEFAULT 'polite' CHECK (tone IN ('polite','firm','final','legal')),
  escalation_order int NOT NULL DEFAULT 1,
  send_weekdays_only boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE dunning_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_invoice_id uuid NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES dunning_templates(id),
  sent_at timestamptz NOT NULL DEFAULT now(),
  sent_to_email text NOT NULL,
  source_document_id uuid REFERENCES captured_documents(id),
  response_received_at timestamptz,
  response_action text                     -- 'paid' | 'promised' | 'disputed' | 'silent'
);
```

---

## 5. Services & APIs

### 5.1 New services (`src/modules/accounting/services/ar/`)

| Service | Responsibility |
|---|---|
| `invoicePdfSnapshotService.ts` | On approve/send, render the PDF once, hash it, upload, stamp `customer_invoices.source_document_id`. Never re-render for the auditor view. |
| `portalAccessService.ts` | Token-gated customer portal — mint view sessions, log each open to `customer_invoice_views`, serve the snapshot PDF. |
| `readReceiptService.ts` | Tracking-pixel endpoint for email-sent invoices. Writes a `view_source='tracking_pixel'` row. |
| `disputeService.ts` | CRUD disputes, close with resolution note, separate aging bucket. |
| `receiptMatchService.ts` | Extends `bankMatchCandidatesService` with portal-view, reference, and embedding signals — single scored shortlist per bank line. |
| `dunningService.ts` | Template CRUD + scheduler + send pipeline + response-tracking webhook. |
| `sentMirrorService.ts` | Mirror of `imapMirrorService` — watches Sent folders. |
| `arDashboardService.ts` | Aggregates: disputed R, overdue non-disputed R, auto-matched % last 30d, reminder response rate. |

### 5.2 New endpoints (`pages/api/accounting/ar/`)

```
POST   /ar/invoice/[id]/render-snapshot     (idempotent — no-op if already snapshotted)
GET    /ar/invoice/[id]/pdf                 (returns the sealed snapshot; falls back to render if missing)
GET    /ar/invoice/[id]/portal-link         (mints a portal session token)

GET    /ar/invoice/[id]/views               (list portal views + read-receipt pings)
GET    /ar/pixel/[invoiceId]/[token].gif    (tracking pixel endpoint)

GET    /ar/disputes
POST   /ar/disputes                         body: { invoiceId, lineId?, amount, reason }
POST   /ar/disputes/[id]/resolve            body: { note, credit_note_id? }
POST   /ar/disputes/[id]/withdraw

GET    /ar/receipt-match/[bankTxId]         (top 5 scored candidates)
POST   /ar/receipt-match/confirm            body: { bankTxId, customerInvoiceId, amount }

GET    /ar/dunning/templates
POST   /ar/dunning/templates
POST   /ar/dunning/templates/[id]/preview   body: { invoiceId } → rendered subject+body
POST   /ar/dunning/send                     body: { invoiceId, templateId } → inserts dunning_sends + email

GET    /portal/invoice/[token]              (public, customer-facing)
POST   /portal/invoice/[token]/dispute      body: { lineId?, amount, reason }
POST   /portal/invoice/[token]/confirm-paid body: { paidOn, reference }

# Cron
POST   /api/cron/dunning-send               (X-Cron-Secret; walks overdue invoices through templates)
POST   /api/cron/sent-mirror-scan           (X-Cron-Secret; every 10 min)
POST   /api/cron/ar-matview-refresh         (X-Cron-Secret; nightly; refreshes customer_invoice_view_summary)
```

### 5.3 Modifications to existing services

- `customerInvoiceWorkflowService.ts` — on `approve`/`send` transition, call `invoicePdfSnapshotService.snapshot(id)` synchronously. Rejection path: roll back the snapshot row if send fails.
- `bankAllocationService.ts` — prefer `receiptMatchService` scored shortlist over the raw fuzzy-match list.
- `arAgingService.ts` — split output into `overdue_total` and `disputed_total`, segregate by bucket.
- `customerInvoicePdfBuilder.ts` — called once, at snapshot time; after that read from storage.

---

## 6. UI Pages

### 6.1 New

| Route | Purpose |
|---|---|
| `/accounting/ar/disputes` | Dispute queue — open, aging, filter by customer, resolve/withdraw actions |
| `/accounting/ar/disputes/[id]` | Detail: invoice context, original email, resolution composer |
| `/accounting/ar/dunning` | Template list, tone picker, per-customer override |
| `/accounting/ar/dunning/runs` | Send history, response tracking dashboard |
| `/accounting/ar/receipt-match` | Bank line → invoice reconciliation with confidence-scored candidates |
| `/portal/invoice/[token]` | Customer-facing — view, dispute, confirm paid |
| `/accounting/ar/settings/sent-mirror` | OAuth connections, last scan, stats |

### 6.2 Modifications

- **Customer invoice detail:** add "Evidence" tab — snapshot PDF, view history, dispute list, dunning sends, related receipts.
- **AR Aging:** new column "Disputed" split from "Overdue"; filter toggle.
- **Bank reconciliation:** when a line has a high-confidence match, surface it inline rather than opening the full match modal.
- **Reports / TB drill:** click a Revenue line → drill through to snapshot PDF (not re-rendered version).
- **Customer detail:** "Views" sparkline showing engagement over time.

---

## 7. Phased Delivery

### Phase 1 — Invoice-as-Evidence (1 week) `P0`

- Migration for `customer_invoices` columns + `customer-invoices` storage bucket
- `invoicePdfSnapshotService` — idempotent snapshot on approve/send
- `GET /ar/invoice/[id]/pdf` — returns sealed version
- Extended TB drill-through (reports side) to prefer snapshot
- **Exit criteria:** send an invoice, verify the PDF hash matches what the customer received; TB drill shows the exact same bytes 6 months later.

### Phase 2 — Customer Portal + Access Log (2 weeks) `P0`

- `portal_session` token model, `customer_invoice_views` table
- `/portal/invoice/[token]` page: view PDF, pay (placeholder), dispute
- Tracking pixel for emailed invoices
- Materialised view + nightly refresh cron
- Per-customer "last viewed" summary on AR list
- **Exit criteria:** bookkeeper sends an invoice; customer opens it; the AR list shows "viewed 3 minutes ago" within 60s.

### Phase 3 — Dispute Workflow (1.5 weeks) `P0`

- `customer_invoice_disputes` + service + portal endpoint
- Dispute queue UI + resolution flow (paired with credit-note creation when resolved with a credit)
- Aging split: disputed amounts move to their own bucket
- **Exit criteria:** customer disputes a line via portal; AR aging immediately excludes it from "overdue"; resolving the dispute either re-ages it or auto-creates a credit note.

### Phase 4 — Receipt Auto-Match (1.5 weeks) `P1`

- `receiptMatchService` — scored candidates: exact reference > partial reference + portal-view > amount + date
- Bank-rec UI shows confidence score + top match inline
- Confirm endpoint closes the loop and stamps evidence
- **Exit criteria:** monthly bank import of 500 transactions; ≥95% of customer receipts auto-match to the right invoice.

### Phase 5 — Dunning Engine (2 weeks) `P1`

- `dunning_templates` + `dunning_sends` + SA-tone defaults (polite / firm / final / legal)
- Daily cron walking overdue invoices through the template ladder
- Customer-preview-before-send for first run; auto-send after opt-in
- Response inbox → webhook → `dunning_sends.response_action` update
- **Exit criteria:** 90 days of overdue receivables run through the ladder unattended; response rate telemetry visible.

### Phase 6 — Sent Mirror (1 week) `P1`

- IMAP / Gmail / M365 sent-folder watcher
- Invoice-hash link-back so outbound PDFs don't duplicate `captured_documents` rows
- UI: connection list in AR settings
- **Exit criteria:** connect Gmail sent folder; an invoice emailed outside the app links back to the snapshot automatically.

### Phase 7 — Customer Payment Rail (2 weeks) `P2`

- PayFast / Ozow / Stripe ZA integration behind the portal "Pay" button
- On paid, match to `bank_transactions` via portal reference
- Payment-received webhook → customer_invoice transition → evidence stamp
- **Exit criteria:** customer clicks "Pay now", settles online, invoice flips to paid + bank line allocated without human action.

### Phase 8 — Reminder AI + Personalisation (2 weeks) `P2`

- Per-customer tone learning: if they always pay within 2 days of reminder #2, skip reminder #1
- AI-rewritten subject lines based on response history
- **Exit criteria:** average days-sales-outstanding drops 7+ days across 20 tenants at 6 months.

**Total estimated effort:** 13–15 engineer-weeks; P0 core loop (Phases 1-3) ships in 4.5 weeks.

---

## 8. Success Metrics

| Metric | Baseline | Target (12 weeks post-launch) |
|---|---|---|
| % customer invoices with sealed PDF snapshot | 0% | 100% |
| % customer receipts auto-matched to invoice | ~70% (amount+date) | ≥95% |
| Days-sales-outstanding (median, cohort) | ~60 | ≤45 |
| % overdue invoices without dispute complaint backlog | n/a | ≥90% |
| Dispute resolution time (median) | n/a | ≤5 working days |
| Tenants using AR portal | 0% | ≥50% |
| Dunning response rate (any action) | n/a | ≥30% |
| TB drill-to-evidence coverage (AR side) | 0% | 100% |

---

## 9. Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Portal URL tokens leak via forward/share | Med | High | Short TTL (14 days) + per-session bind to first IP; one-click revoke |
| Customer disputes everything to delay payment | Low | Med | Dispute must carry a reason; unreasonable-dispute rate surfaces to the collector |
| Snapshot PDF storage cost balloons | Low | Low | Bucket lifecycle policy: move to cold storage after 3y; delete at 7y per POPIA |
| Tracking pixel gets flagged as spam | Med | Low | Host on isaflow.co.za domain with a legitimate Content-Type; opt-out per customer |
| Sent-folder mirror catches unrelated emails | Med | Med | Hash-match against snapshots FIRST; only create capture_event if hash matches a tenant invoice |
| Dunning sends during a payment processor outage | Low | Med | Cron polls payment gateway status; pauses sends if provider 5xx rate > 20% over 1h |
| Customer-portal DoS via tracking pixel endpoint | Low | Low | Rate-limit per IP + per token; 1 pixel per 5s |

---

## 10. Open Questions

1. **Hashed-view privacy vs. debug-ability** — We keep a one-way `session_token` hash. Do we also keep the raw IP for 30d before anonymising, or from the first view? Recommendation: anonymise after 30d; deletion log kept for 2y.
2. **Dispute auto-credit** — Some disputes settle with a credit note. Should resolution optionally *create* the credit note, or always require a manual pass? Recommendation: opt-in per company.
3. **Payment rail** — Single provider (PayFast) first, or multi from day one? Recommendation: PayFast MVP; Stripe + Ozow in Phase 8.
4. **Dunning tone AI** — Use local VLM or outsource to Claude Haiku? Recommendation: Haiku for rewrites, cached per template. Cheaper per-tenant than running a local model for text.
5. **Portal authentication** — Token-only or email magic link? Recommendation: token-only for MVP; magic link in Phase 7.

---

## 11. Out of Scope (for this PRD)

- **Subscription / recurring billing** — covered by a separate billing module (PRD-10 candidate).
- **Factoring / AR finance integration** — sell receivables to a finance provider. Nice-to-have, not ledger-core.
- **Collections agency handover workflow** — export-only for MVP; full integration deferred.
- **Customer credit scoring** — owns the lane, not ours yet.
- **AR forecasting / cashflow prediction** — continues in the cashflow-forecast module.

---

## 12. Dependencies

- PRD-05 evidence-graph infra (shipped)
- Supabase Storage bucket: `customer-invoices` (new)
- Postmark inbound (or SES) for dunning replies — existing domain DMARC config needed
- PayFast merchant account (Phase 7)
- IMAP / Gmail / M365 OAuth app registration (Phase 6 — shared with PRD-05 Phase 9)
