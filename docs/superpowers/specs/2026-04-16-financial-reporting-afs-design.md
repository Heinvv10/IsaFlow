# ISaFlow — Financial Reporting & AFS Engine Design Spec

**Date:** 2026-04-16  
**Status:** Approved — ready for implementation planning  
**Scope:** Full Annual Financial Statements engine, Monthly Management Packs, IFRS Compliance Layer  
**Author:** Brainstorming session — Hein van Vuuren + Claude

---

## Background & Motivation

ISaFlow currently produces individual financial reports (trial balance, income statement, balance sheet, cash flow) but has no unified Annual Financial Statements (AFS) bundle, only 7 of the ~30 required IFRS disclosure notes, no Statement of Changes in Equity, no print-quality PDF export, no review workflow, and no monthly management pack delivery system.

This design spec covers the complete upgrade to make ISaFlow a best-in-class financial reporting platform for the South African market — competing directly with Caseware, Draftworx, Fathom, and Syft Analytics.

**Key competitive insight:** No current SA tool offers (1) AI-generated note narrative, (2) real-time IFRS disclosure completeness checking, (3) combined AFS + management pack in one product, or (4) premium visual design in AFS output. ISaFlow will have all four.

---

## Design Decisions (Confirmed)

| Decision | Choice |
|---|---|
| Reporting frameworks | IFRS for SMEs + Full IFRS, switchable per company |
| Export formats | PDF + DOCX + Caseware export |
| Note automation | Data-driven + AI narrative + review workflow + client portal |
| Cash flow methods | Both indirect + direct, with reconciliation note |
| Monthly pack | Auto-generated, fully configurable, scheduled delivery |
| Architecture | Caseware-style document engine (Approach C) |
| PDF engine | WeasyPrint (Docker sidecar, free, BSD licence) |
| E-signatures | Signum (internal, on velo) — see Signum changes section |

---

## Section 1: Core Document Model

### AFS Document

The centre of the system. One `AfsDocument` per company per fiscal year (or per month for management packs).

```
AfsDocument
├── id (UUID)
├── company_id
├── fiscal_year (integer) OR period (YYYY-MM for management packs)
├── document_type ('afs' | 'management_pack')
├── reporting_framework ('ifrs_smes' | 'full_ifrs')
├── status ('draft' | 'in_review' | 'partner_review' | 'signed_off' | 'filed')
├── locked_at / locked_by
├── version (integer, auto-incremented)
├── pis_score (calculated at generation time)
└── created_at / updated_at
```

### AFS Section

One record per statement and per note within a document.

```
AfsSection
├── id (UUID)
├── document_id → AfsDocument
├── section_type (see registry below)
├── status ('pending' | 'auto_generated' | 'ai_enhanced' | 'reviewed' | 'signed_off')
├── data_snapshot (JSONB — raw GL figures at generation time, immutable)
├── content (JSONB — rendered NoteContent: text blocks + tables)
├── overrides (JSONB — accountant edits layered on top of content)
├── ai_narrative (TEXT)
├── ai_narrative_accepted (boolean)
├── reviewed_by / reviewed_at
├── signed_off_by / signed_off_at
└── version_history (JSONB array — every prior state)
```

### Note Template

Pre-registered templates for all 30+ note types. Vendor-maintained with version tracking.

```
NoteTemplate
├── id
├── section_type
├── framework ('ifrs_smes' | 'full_ifrs' | 'both')
├── title
├── data_queries (JSONB — named SQL query specs)
├── content_schema (JSONB — shape of NoteContent)
├── ai_prompt_template (TEXT)
├── is_mandatory (boolean)
├── standard_reference (e.g. "IAS 16", "IFRS for SMEs Section 17")
├── effective_from (date)
├── supersedes (prior template id)
└── change_summary (TEXT — what changed when standard was updated)
```

### DB Tables Required

- `afs_documents`
- `afs_sections`
- `note_templates`
- `afs_generation_log` (job queue for async generation)
- `management_pack_configs`

### Key Principles

- **Data/presentation separation:** `data_snapshot` is immutable after generation. `content` is rendered output. `overrides` layer accountant edits on top — never touching underlying data.
- **Immutability on sign-off:** Signed-off sections are frozen. Any edit creates a new version entry.
- **Framework-aware:** Template registry knows which notes apply to IFRS for SMEs vs Full IFRS. Documents only include applicable sections.

---

## Section 2: The Note Engine

### 4-Stage Pipeline

```
[1] DATA FETCH → [2] CONTENT RENDER → [3] AI NARRATIVE → [4] PERSIST
```

**Stage 1 — Data Fetch:** Each `NoteTemplate.data_queries` runs against the GL, sub-ledgers, and fixed asset register for `company_id` + `fiscal_year`. All queries run in parallel (`Promise.all`). Results stored verbatim in `AfsSection.data_snapshot` before any rendering.

**Stage 2 — Content Render:** A `NoteRenderer` takes `data_snapshot` + `content_schema` and produces the `content` JSONB:

```typescript
interface NoteContent {
  title: string;
  blocks: Array<
    | { type: 'paragraph'; text: string }
    | { type: 'table'; headers: string[]; rows: string[][] }
    | { type: 'list'; items: string[] }
    | { type: 'heading'; text: string; level: 2 | 3 }
  >;
}
```

This structure drives the web UI, PDF, and DOCX — same model, three renderers.

**Stage 3 — AI Narrative:** Async pass per note with `ai_prompt_template`. AI receives rendered content + prior year comparatives + company context. Output stored in `AfsSection.ai_narrative`. Never auto-accepted — accountant sees it as a suggestion. Once accepted it merges into `overrides`.

**Stage 4 — Persist + Job Queue:** Generation runs as a background job via `jobQueueService`. UI shows per-section progress. Accountant can start reviewing early sections while later ones generate.

### The 30-Note Registry

| # | Note | IFRS SMEs | Full IFRS | Auto-gen | AI narrative |
|---|------|:---------:|:---------:|:--------:|:------------:|
| 1 | Accounting Policies | ✓ | ✓ | ✓ | ✓ |
| 2 | Estimates & Judgements | ✓ | ✓ | partial | ✓ |
| 3 | Property, Plant & Equipment | ✓ | ✓ | ✓ | ✓ |
| 4 | Right-of-Use Assets | — | ✓ | ✓ | ✓ |
| 5 | Intangible Assets | ✓ | ✓ | ✓ | ✓ |
| 6 | Investment Property | ✓ | ✓ | ✓ | ✓ |
| 7 | Investments in Associates | ✓ | ✓ | ✓ | ✓ |
| 8 | Financial Assets | ✓ | ✓ | ✓ | ✓ |
| 9 | Inventories | ✓ | ✓ | ✓ | ✓ |
| 10 | Trade Receivables | ✓ | ✓ | ✓ | ✓ |
| 11 | Cash & Cash Equivalents | ✓ | ✓ | ✓ | — |
| 12 | Share Capital & Reserves | ✓ | ✓ | ✓ | ✓ |
| 13 | Borrowings | ✓ | ✓ | ✓ | ✓ |
| 14 | Lease Liabilities (IFRS 16) | — | ✓ | ✓ | ✓ |
| 15 | Provisions | ✓ | ✓ | ✓ | ✓ |
| 16 | Trade & Other Payables | ✓ | ✓ | ✓ | — |
| 17 | Income Tax & Deferred Tax | ✓ | ✓ | ✓ | ✓ |
| 18 | Revenue Disaggregation | ✓ | ✓ | ✓ | ✓ |
| 19 | Other Income / Finance Income | ✓ | ✓ | ✓ | — |
| 20 | Operating Expenses by Nature | ✓ | ✓ | ✓ | — |
| 21 | Finance Costs | ✓ | ✓ | ✓ | — |
| 22 | Employee Benefits | ✓ | ✓ | ✓ | ✓ |
| 23 | Related Party Disclosures | ✓ | ✓ | partial | ✓ |
| 24 | Auditor's Remuneration | ✓ | ✓ | manual | — |
| 25 | Contingencies & Commitments | ✓ | ✓ | manual | ✓ |
| 26 | Events After Reporting Date | ✓ | ✓ | manual | ✓ |
| 27 | Going Concern | ✓ | ✓ | partial | ✓ |
| 28 | Segment Information | — | ✓ | ✓ | ✓ |
| 29 | Financial Instruments Risk | — | ✓ | ✓ | ✓ |
| 30 | Standards Not Yet Effective | ✓ | ✓ | ✓ | — |

**"Partial"** = numbers auto-generate, narrative requires accountant input.

### Additional Note Engine Features

- **Auto-suppress zero-balance notes:** Notes with no relevant GL data are suppressed automatically, with a logged reason code. Accountant can override and force-include.
- **Note reordering:** Drag-and-drop to change note sequence within the editor. Sequence stored in `AfsSection.sort_order`.
- **Standard update alerts:** When a `NoteTemplate` is updated (e.g. new IFRS amendment), all AFS documents using the old template version are flagged for review with a change summary.

---

## Section 3: The Four Primary Statements + Changes in Equity

All statements become `AfsSection` records within the `AfsDocument`. Each uses existing ISaFlow services as data sources — no rewrites, only routing through the document engine.

### Statement of Financial Position (Balance Sheet)

- **Source:** `balanceSheetService.ts`
- Comparative column (prior fiscal year) auto-fetched in parallel
- Current vs non-current classification validated against `account_subtype`
- IFRS for SMEs layout (no OCI reclassification) and Full IFRS layout (OCI components in equity)
- Auto-calculated subtotals with cross-check

### Statement of Comprehensive Income (Income Statement)

- **Source:** `incomeStatementService.ts`
- Presentation by function (current) or by nature (user-selectable)
- EBITDA line auto-inserted
- OCI section for Full IFRS entities
- Comparative column

### Statement of Changes in Equity *(new — does not exist yet)*

Movement table across all equity components for the year:

```
                  Share    Share    Retained  Revaluation  Total
                  Capital  Premium  Earnings  Reserve      Equity
Opening balance    xxx      xxx      xxx        xxx          xxx
Profit for year     —        —       xxx         —           xxx
OCI for year        —        —        —          xxx          xxx
Dividends paid      —        —      (xxx)         —          (xxx)
Share issue        xxx      xxx       —            —          xxx
Closing balance    xxx      xxx      xxx          xxx         xxx
```

Data sources: balance sheet (opening/closing), income statement (profit), GL dividend tags, equity account movements, revaluation reserve. For IFRS for SMEs entities where only retained earnings changed, the simplified Statement of Income and Retained Earnings is offered instead.

### Statement of Cash Flows

- **Source:** Extended from `reports-cash-flow` API
- **Indirect method** (already exists, cleaned up): profit → adjustments → working capital → operating/investing/financing
- **Direct method** (new): derived from `bank_transactions` — categorise actual cash receipts and payments by their bank allocation tags
- **Reconciliation note** (new): auto-generated proof that both methods produce the same closing cash balance = bank statement balance. Any variance flagged for accountant review.
- User-selectable per document; both can be included together

### Cover & Director's Report Sections

- **Cover:** Company name, registration number, address, directors, nature of business, reporting period, date of approval
- **Director's Report:** AI-assisted narrative template covering: activities, financial results, dividends, going concern, events after reporting date, future prospects, directors' interests, major shareholders

---

## Section 4: Export & Rendering

### PDF Generation — WeasyPrint

**Engine:** WeasyPrint (Docker sidecar, Python, BSD licence, free)  
**Fallback/upgrade path:** DocRaptor API (PrinceXML quality, ~$75–200/month) — one config change

**Architecture:**
```
[React component tree]
        ↓
[HTML + CSS rendered server-side]
        ↓
[WeasyPrint sidecar — Docker container on velo]
        ↓
[PDF/A output — streamed to client or stored in object storage]
```

The same HTML + CSS is the **interactive web view** — one template, two outputs.

**PDF document structure:**
```
Page 1:    Cover page
Page 2:    Table of Contents (auto-generated)
Page 3:    Director's Report
Page 4:    Independent Reviewer's / Auditor's Report (manual upload slot)
Pages 5+:  Statement of Financial Position
           Statement of Comprehensive Income
           Statement of Changes in Equity
           Statement of Cash Flows
           Notes 1–30 (framework-filtered)
Last page: Signature block
```

### DOCX Generation

**Library:** `docx` (pure JS)  
Mirrors PDF structure. All text as editable paragraphs. Tables as native Word tables. Named styles applied consistently (Heading 1/2/3, Body Text, Table Header, Note Number). Track changes enabled. Financial tables in protected content controls.

Post-edit round-trip: accountant edits DOCX, returns it, signed PDF uploaded back as final copy.

### Caseware Export

Extended from existing `casewareExportService.ts`:
- Trial balance (CSV, Caseware account code mapping)
- Journal entries file
- Fixed asset register
- AR/AP aging schedules
- Bank reconciliation summary
- Manifest file
- XBRL/CIPC taxonomy pre-linked fields

### API Endpoints

```
POST /api/accounting/afs                                     — create document
GET  /api/accounting/afs                                     — list documents
GET  /api/accounting/afs/[documentId]                        — get + all sections
POST /api/accounting/afs/[documentId]/generate               — trigger generation job
GET  /api/accounting/afs/[documentId]/export?format=pdf|docx|caseware
PUT  /api/accounting/afs/[documentId]/sections/[sectionId]   — save overrides
POST /api/accounting/afs/[documentId]/sign-off               — lock document
POST /api/accounting/afs/webhook/signed                      — Signum webhook receiver
```

---

## Section 4b: Document Design System

### Brand Profile (per company)

```
BrandProfile
├── logo_url
├── primary_colour (hex)
├── secondary_colour (hex)
├── font_family ('professional' | 'modern' | 'executive' | 'bold')
├── cover_style ('classic' | 'modern' | 'bold' | 'minimal')
├── industry_photos[] (tagged: cover, section_divider, background)
└── report_footer_text
```

### Cover Page Styles

- **Classic:** Full-bleed photo + dark overlay, logo top-right, title centred in white
- **Modern:** Split layout — colour panel left, photo right, title on semi-transparent strip
- **Bold:** Full primary-colour cover, geometric pattern, no photo
- **Minimal:** White cover, centred logo, thin rule, clean typography only

### Typography — 4 Font Pairs

| Pair | Heading | Body | Feel |
|------|---------|------|------|
| Professional | Playfair Display | Source Serif Pro | Traditional |
| Modern | Inter | Inter | Clean, tech |
| Executive | Cormorant Garamond | Lato | Elegant |
| Bold | Montserrat | Open Sans | Confident |

### Table Design System

- Header row: primary colour background, white bold text
- Subtotal rows: light primary tint, bold
- Total rows: primary colour, white bold
- Alternating row shading: very light grey on even rows
- Numbers: right-aligned, monospace, brackets for negatives
- Currency symbol: once in header (e.g. "R'000"), not per row
- No vertical lines — horizontal rules only (modern convention)

### Photo Placement

- Cover: full-bleed (3mm bleed on all edges)
- Section dividers: quarter-page strip with section title overlay
- Director's Report: inline photos (facility, team, product)
- PPE note: photo of major assets being depreciated
- Photo library: drag-to-upload, tag by use, drag-to-place in editor
- Image quality warning: < 150 DPI flagged at upload

### Chart Embeds

Server-side SVG rendering via `@nivo` embedded in HTML before WeasyPrint converts. No canvas, no screenshots. Chart types: bar, line, area, donut, waterfall.

### In-App Live Preview

Document editor shows real-time styled preview as accountant works — HTML/CSS rendering of the same `NoteContent` model. What you see is what the PDF produces.

---

## Section 4c: Document Quality & Print Hardening

### Seven Page Break Rules (enforced at renderer level)

1. Never break table header from first row — if < 3 rows fit, push entire table to next page
2. Never break note heading from its first paragraph (`keepWithNext`)
3. Table rows are atomic — never split mid-row
4. Repeated table headers on continuation pages with "(continued)" label
5. Widow/orphan control — minimum 2 lines on either side of any page break
6. Section integrity — each major section starts fresh or has ≥ 40% page available
7. Director's Report and Cover always start on their own pages (Cover = page 1, Director's Report = right/odd page)

### White Space Rules

- Page margins: 20mm top/bottom, 25mm left, 20mm right
- Between notes: 12pt before note number/title, 6pt after
- Table cell padding: 6pt vertical, 8pt horizontal
- Paragraph leading: 1.4× font size
- Page footer: company name left, page number right, thin rule 8pt from edge

### WeasyPrint CSS Print Rules

```css
@page {
  size: A4 portrait;
  margin: 20mm 20mm 20mm 25mm;
  @bottom-right { content: counter(page); }
  @bottom-left  { content: string(company-name); }
}
tr    { break-inside: avoid; }
thead { display: table-header-group; }
.note-heading { break-after: avoid; }
p     { widows: 2; orphans: 2; }
.section-start { break-before: right; }
@page landscape { size: A4 landscape; }
.wide-table { page: landscape; }
```

**Known WeasyPrint limitation:** `thead` repeat + `break-inside: avoid` can conflict on complex tables. Mitigation: financial table templates designed to avoid combining both on the same table.

### Column Width Rules

- ≤ 5 columns: standard layout, description wider
- 6–8 columns: description fixed at 35%, numerics share 65%
- > 8 columns: auto landscape page rotation for that section

### Pre-Export Quality Check

| Check | Severity |
|-------|----------|
| Assets = Liabilities + Equity | 🔴 Blocker |
| Closing cash = bank balance | 🔴 Blocker |
| All mandatory notes present | 🔴 Blocker |
| Comparative figures present | 🟡 Warning |
| All notes reviewed | 🟡 Warning |
| Low-res images (< 150 DPI) | 🟡 Warning |
| Director's Report not approved | 🟡 Warning |
| Note cross-references valid | 🟡 Warning |

Blockers prevent export. Warnings require confirmation with a logged reason.

### Proof Copy Workflow

Draft exports watermarked "DRAFT — NOT FOR DISTRIBUTION" with a built-in review checklist:
- Cover page correct
- Director names/designations correct
- Comparative figures agree to prior AFS
- Note cross-references accurate
- Page numbers sequential
- Table of contents page numbers match
- Auditor's report uploaded and legible
- Company registration number correct throughout

Accountant completes checklist before promoting Draft → Reviewed.

### DOCX Quality Rules

- All spacing via paragraph styles, never empty-paragraph spacers
- `keepRows: true` on all financial tables
- `Repeat as header row` set on all tables
- Financial table columns in protected content controls
- Named styles throughout — no direct formatting

---

## Section 5: Review Workflow

### Section Lifecycle

```
pending → auto_generated → ai_enhanced → reviewed → signed_off
```

Signed-off sections are immutable. Any edit creates a new version and resets to `reviewed`.

### Document Lifecycle

```
draft → in_review → partner_review → signed_off → filed
```

- **Draft:** Proof copy (watermarked) only
- **In review:** All mandatory sections at least `reviewed`
- **Partner review:** Senior working through sign-offs
- **Signed off:** All mandatory sections `signed_off`, final export unlocked
- **Filed:** CIPC filing recorded, document archived

### Role-Based Access

| Role | Generate | Edit | Review | Sign Off | File |
|------|:--------:|:----:|:------:|:--------:|:----:|
| Bookkeeper | ✓ | ✗ | ✗ | ✗ | ✗ |
| Accountant | ✓ | ✓ | ✓ | ✗ | ✗ |
| Senior Accountant | ✓ | ✓ | ✓ | ✓ (sections) | ✗ |
| Partner / Director | ✓ | ✓ | ✓ | ✓ (document) | ✓ |
| Client (read-only) | ✗ | ✗ | ✗ | ✗ | ✗ |

### Review UI — Two Views

- **Document view:** Full styled preview, click any section to edit, status badges visible
- **Checklist view:** Compact list of all 35+ sections — status, reviewer, last modified. Partner uses this for systematic sign-off.

### Comments & Review Notes

Per-section comment threads (never exported). Unresolved comments block sign-off. All comments resolved before a section can be signed off.

### Version History

Every override save appended to `version_history` with: version number, timestamp, author, change summary, full content snapshot. One-click restore to any prior version (creates new version entry — nothing deleted).

### Client Annotation Layer

Directors can annotate draft sections from the client portal. Annotations appear in the accountant's review workflow. Accountant accepts or rejects each suggestion. Annotations disabled once document reaches `signed_off`.

### Notifications

| Event | Notifies |
|-------|---------|
| Generation complete | Triggering accountant |
| Section submitted for review | All seniors on the file |
| Partner review requested | Assigned partner |
| Comment added | Section assignee + thread participants |
| Document signed off | Client (portal) + filing reminder |
| Filing deadline approaching | Accountant + partner (30/14/7 days) |

Filing deadline = fiscal year-end + 6 months (Companies Act). Auto-calculated, stored on `AfsDocument`.

---

## Section 6: Client Portal

### Access Model

Separate authenticated view — same domain, different role. Magic link login (email-based, no password) or Google/Microsoft SSO.

**Client roles:** Director (full draft + final access, can annotate, can sign), CFO/Financial Manager (same as Director), Shareholder read-only (final signed AFS only), External Auditor (draft + final, Caseware export, read-only).

### Dashboard

- Latest AFS: status, year, download
- Last 6 management packs: month, status, download
- Pending actions: signing requests, annotation replies needed
- Filing deadlines: CIPC annual return, provisional tax dates
- Firm contact details

### Document Viewer

- Full in-browser preview (HTML/CSS render — same model as PDF)
- Section-by-section sidebar navigation
- Mobile-responsive
- Annotation layer on draft documents (highlight + comment)

### E-Signature via Signum

- Director receives magic link email from Signum
- Link opens ISaFlow's own signing page (`/afs/sign/[token]`) which embeds Signum's signing UI (`?embed=true`)
- Director signs without leaving ISaFlow — full ISaFlow branding
- On completion: `postMessage` to parent → ISaFlow confirms → next director notified (if sequential)
- All signed → Signum fires `document.signed` webhook → ISaFlow marks `signed_off` → downloads signed PDF → stores as final copy

### Document Library

Organised by type (AFS, Management Accounts, Other), sorted newest first. Full history accessible forever.

### Security

- Signed URLs with 1-hour expiry for direct downloads
- Magic links expire after 15 minutes, single-use
- All client actions logged to audit trail
- POPIA-compliant data handling
- Full tenant isolation

---

## Section 7: Monthly Management Pack & Scheduler

### Pack as Document

Management packs use the same `AfsDocument` model with `document_type: 'management_pack'` and `period: 'YYYY-MM'`.

### Configurable Sections (16 total)

| # | Section | Default |
|---|---------|---------|
| 1 | Cover page | On |
| 2 | AI Executive Summary | On |
| 3 | KPI Scorecard | On |
| 4 | Income Statement (month + YTD) | On |
| 5 | Income Statement vs Budget | On |
| 6 | Balance Sheet | On |
| 7 | Cash Flow Statement | On |
| 8 | Debtors Ageing | On |
| 9 | Creditors Ageing | On |
| 10 | Bank Reconciliation Summary | On |
| 11 | Revenue Analysis | Off |
| 12 | Expense Analysis | Off |
| 13 | Budget vs Actual Variance | Off |
| 14 | 13-Week Cash Flow Forecast | Off |
| 15 | VAT Dashboard | Off |
| 16 | CFO Narrative (manual) | Off |

### Pack Configuration (`ManagementPackConfig`)

```
ManagementPackConfig
├── company_id
├── enabled (boolean)
├── generation_day (1–28)
├── delivery_day (generation_day + offset)
├── review_required (boolean)
├── sections_enabled (JSONB)
├── recipients (JSONB — { email, role, receives: 'draft'|'final'|'both' })
├── pack_style ('executive' | 'detailed' | 'board')
├── comparison_mode ('prior_month' | 'prior_year' | 'budget' | 'all_three')
└── currency_display ('full' | 'thousands' | 'millions')
```

### Three Pack Styles

- **Executive:** 8 pages max, charts-heavy, minimal tables, one-page KPI dashboard, AI narrative prominent. For business owners.
- **Detailed:** 15–20 pages, full tables + charts, all variance analysis. For CFOs.
- **Board:** Formal AFS-matching layout, portrait, conservative typography. For board meetings.

### Generation Job (runs at 06:00 SAST on `generation_day`)

1. Lock period (prevent duplicates)
2. Fetch all data in parallel
3. Generate section content (Note Engine pipeline)
4. AI pass — executive summary + variance commentary per section
5. Render PDF via WeasyPrint
6. Store in document library
7. If `review_required` → notify accountant → hold delivery
8. If no review → deliver immediately

Accountant has `delivery_day - generation_day` days to review before client delivery.

### KPI Scorecard

Designed infographic — not a table:
- Revenue, Gross Margin, EBITDA, Cash (with trend arrows + charts)
- Debtor Days, Creditor Days, Current Ratio, Burn Rate (with RAG traffic lights)
- RAG thresholds configurable per company (sensible SA SME defaults pre-set)
- Charts: SVG rendered server-side via `@nivo`, embedded in HTML pre-WeasyPrint

### AI Executive Summary

One-page plain-English summary generated from month's movements. Input: current vs prior month vs budget vs prior year, working capital movements, cash position, 60+ day debtors, top revenue/expense movers. Output: 3–5 paragraph narrative with specific figures and percentages.

Generated per section too — each pack section gets its own AI commentary paragraph. All AI output is a suggestion — accountant edits and approves before delivery.

### Pack History Library

Full archive by year/month. Year-over-year side-by-side comparison viewer (accountant shows director 12-month improvement).

---

## Section 8: IFRS Compliance Layer & PIS Calculator

### PIS Auto-Calculation

```
PIS = (GL revenue ÷ 1,000,000)
    + employee_count
    + shareholder_count
    + (GL third-party liabilities ÷ 1,000,000)
```

Updated monthly from live GL data. Drives:

| PIS | Standard | Audit Requirement | CIPC Filing |
|-----|----------|-------------------|-------------|
| < 100 (all shareholders = directors) | IFRS for SMEs or other | Voluntary | FAS only |
| < 100 (external shareholders) | IFRS for SMEs | Independent review | AFS |
| 100–349 | IFRS for SMEs | Independent review | AFS |
| ≥ 350 | Full IFRS | Mandatory audit | Full AFS |

Framework auto-set from PIS. Accountant override is allowed but flagged + logged. Threshold crossing fires a compliance alert.

### Real-Time Compliance Checker

Three check categories run continuously as the document is built:

**Structural checks:** All mandatory sections present, no mandatory note suppressed without reason code, Director's Report present with all Companies Act elements, Auditor's Remuneration note present, comparative figures present.

**Mathematical checks:** Balance sheet balances, cash flow closes to bank balance, note totals agree to face statements, income tax effective rate consistent, changes in equity closing = balance sheet equity.

**Disclosure quality checks:** Note 1 covers all material GL account types, related party note covers all directors in Director's Report, PPE depreciation methods match Note 1, revenue disaggregation covers all GL revenue types, events after reporting date has entry or documented nil declaration, going concern flagged if current ratio < 1.0 or net loss recorded.

**Compliance score panel** in editor sidebar — percentage score, passed/warning/blocker counts, clickable warnings that jump to the relevant section.

### IFRS Knowledge Library

Vendor-maintained `NoteTemplate` versions. When a standard changes:
1. New template version created with `effective_from`, `supersedes`, `change_summary`
2. All AFS documents using the old version flagged: "Template updated — review required"
3. Accountant sees change summary, reviews updated template, accepts or customises

### CIPC Filing Guide

Auto-populated checklist within the AFS document:
- Company details, PIS score, filing deadline (year-end + 6 months)
- Required filings based on PIS (AFS or FAS, audit or review)
- Documents ready checklist (AFS signed off, reviewer report uploaded, annual return submitted)
- Living checklist — updates as each item is completed

### Compliance Alerts

| Trigger | Alert |
|---------|-------|
| PIS crosses 100 | "Independent review now required" |
| PIS crosses 350 | "Mandatory audit required — Full IFRS may apply" |
| AFS not generated within 5 months of year-end | "Filing deadline in 30 days" |
| CIPC annual return overdue | "Annual return overdue — penalties may apply" |
| Bank account unreconciled 30+ days | "Reconciliation outstanding — may affect AFS accuracy" |

---

## Signum Changes Required

Before ISaFlow AFS integration can go live, Signum needs four changes:

1. **Replace Puppeteer with WeasyPrint** in `lib/html-to-pdf.ts` — same function signature, same input/output, higher quality output.

2. **Add embed mode** (`?embed=true`) to `/sign/[token]` page — removes Signum header/nav, renders only document viewer + signature controls, fires `postMessage({ type: 'signum:signed' })` to parent window on completion.

3. **Configurable `callbackBaseUrl`** per document — allows ISaFlow to pass `callbackBaseUrl: "https://app.isaflow.co.za/afs/sign"` so signing email links go to ISaFlow's domain.

4. **Configurable `expiresInDays`** per document — default 7 days is too short for AFS signing. ISaFlow will pass 30 days.

---

## Competitive Positioning Summary

| Feature | ISaFlow | Draftworx | Caseware | Fathom | Syft |
|---------|:-------:|:---------:|:--------:|:------:|:----:|
| IFRS for SMEs + Full IFRS | ✓ | ✓ | ✓ | ✗ | ✗ |
| AI inline note drafting | ✓ | ✗ | ✗ | ✗ | ✗ |
| Real-time compliance checker | ✓ | ✗ | ✗ | ✗ | ✗ |
| Premium visual design in AFS | ✓ | ✗ | ✗ | ✓* | ✓* |
| Combined AFS + management pack | ✓ | ✗ | ✗ | ✗ | ✗ |
| Client annotation on draft AFS | ✓ | ✗ | ✓ | ✗ | ✗ |
| Both cash flow methods + reconciliation | ✓ | ✗ | ✗ | ✗ | ✗ |
| Transaction drill-down | ✗** | ✗ | ✗ | ✗ | ✓ |
| Interactive web-delivered reports | ✓ | ✗ | ✗ | ✓ | ✓ |

*Management packs only, not AFS  
**Planned Phase 2

---

## Implementation Phases (High Level)

### Phase 1 — Document Engine Foundation
DB migrations, `AfsDocument` + `AfsSection` models, `NoteTemplate` registry, generation job queue, basic AFS page at `/accounting/afs/`.

### Phase 2 — Note Engine + 30 Notes
All 30 note data queries, content renderers, and AI prompt templates. Auto-suppress zero-balance notes. Note reordering.

### Phase 3 — Primary Statements
Statement of Changes in Equity (new). Direct method cash flow (new). Reconciliation note (new). Wire all statements into document engine.

### Phase 4 — Export & Design System
WeasyPrint Docker sidecar. PDF generation. Brand profile. Cover page styles. DOCX generation. Caseware export extension.

### Phase 5 — Review Workflow
Section/document lifecycle. Role-based access. Comment threads. Version history. Proof copy. Pre-export quality checks.

### Phase 6 — Client Portal + Signum
Client portal pages. Magic link auth. Document viewer. Signum integration (requires Signum changes as specified above). E-signature flow.

### Phase 7 — Management Pack Scheduler
`ManagementPackConfig`. Cron-based generation job. KPI scorecard. AI executive summary. Pack history library. Email delivery.

### Phase 8 — Compliance Layer
PIS calculator. Real-time compliance checker (all 3 check categories). Compliance score panel. CIPC filing guide. Compliance alerts. IFRS Knowledge Library with version tracking.

---

*Spec written: 2026-04-16 | Framework: IFRS for SMEs + Full IFRS | PDF engine: WeasyPrint | E-signatures: Signum*
