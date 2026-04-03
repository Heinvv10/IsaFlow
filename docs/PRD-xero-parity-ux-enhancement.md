# PRD: Feature Parity & UX Enhancement — Xero Competitive Analysis

**Document:** PRD-2026-04-003
**Date:** 2026-04-03
**Author:** Hein van Vuuren
**Status:** APPROVED

---

## 1. Executive Summary

This PRD captures the findings from a hands-on Xero audit and maps them against IsaFlow's current capabilities. The goal is **not** to replicate Xero — IsaFlow already surpasses Xero in depth (100+ pages, 200+ APIs, SA-specific compliance, AI features, group consolidation). The goal is to identify UX patterns and missing convenience features that would make IsaFlow feel more polished, more intuitive, and more complete than Xero for our target market.

**Guiding principles:**
- IsaFlow keeps its own design identity (teal accent, dual-nav, SA-first)
- Feature parity where it matters for user expectations
- UX must be a **step-change improvement**, not a copy
- Every enhancement must earn its place — no feature bloat

---

## 2. Competitive Position Summary

### Where IsaFlow Already Wins

| Area | IsaFlow | Xero |
|------|---------|------|
| SA Compliance | SARS VAT201, EMP201, CIPC, B-BBEE | Basic VAT201 only |
| AI Features | 15+ AI tools (categorisation, forecasting, OCR, NL query) | None built-in |
| Group Consolidation | Full consolidation, eliminations, intercompany | Not available |
| Bank Reconciliation | Sage-style inline allocation, split, match, rules, AI | Simpler reconciliation |
| Reports | 35+ reports, custom builder, report packs, CaseWare export | ~40 reports, no custom builder |
| Fixed Assets | Full register, SARS categories, depreciation, disposals | Basic fixed assets |
| Budgets | Budget manager with variance analysis | Basic budgets |
| Migration | Multi-system wizard (Sage, Xero, QuickBooks, Pastel) | No migration tooling |
| Audit | Field-level audit trail, compliance alerts | Basic audit log |
| Multi-company | Company switcher, group reporting | Organisation switcher only |
| Keyboard shortcuts | Ctrl+K command palette, G-key navigation | Global search only |
| Data Quality | Duplicate detection, merge, data archiving | None |

### Where Xero Has UX Advantages

| Area | What Xero Does Better | IsaFlow Gap |
|------|----------------------|-------------|
| Onboarding | Persistent setup guide checklist with progress % | Tooltip tour only, no task-based checklist |
| Dashboard | Customizable widget layout, "Edit homepage" | Fixed 5-tab layout, no widget customization |
| Empty states | Rich illustrations, CTAs, tutorial videos | Inline text-only empty states |
| First-use wizards | Contextual setup on first invoice/contact/bank | No first-use contextual prompts |
| Online payments | Integrated payment gateway on invoices | Payment gateway exists but not prominent |
| Invoice preview | Live preview during creation | No inline preview |
| Example data | "Preview with example data" toggle | No demo data mode |
| Section settings | Settings accessible from each nav dropdown | Settings in one central page |
| App marketplace | Region-specific app recommendations on dashboard | No marketplace |
| UI primitives | Consistent XUI design system | No shared Button/Input/Modal components |

---

## 3. Enhancement Workstreams

### WS-A: Onboarding & First-Run Experience

**Priority: HIGH** — First impressions determine retention.

#### A1: Setup Guide Checklist (Dashboard Persistent Widget)

Replace the current tooltip tour with a persistent, dismissible setup guide on the dashboard.

**Design (improvement over Xero):**
- Xero uses a horizontal card carousel — this wastes space and only shows 4 of 9 steps
- IsaFlow approach: **Vertical checklist sidebar** that slides in from the right, always accessible via a "Setup guide" icon in the header (like Xero's checkmark icon)
- Each category expands to show sub-tasks with completion status
- Progress bar at the top showing overall completion
- Sub-tasks link directly to the relevant page with a `?setup=true` query param that triggers contextual help
- Categories auto-mark as complete when the user performs the action (event-driven, not manual)

**Categories (9 steps):**
1. Welcome — Watch intro video, explore demo company
2. Company Details — Logo, legal name, registration, address, banking details
3. Financial Setup — Chart of accounts, fiscal year, opening balances, default accounts
4. VAT Configuration — VAT registration, tax rates, VAT period
5. Connect Bank — Add bank account, import first statement, set up bank feed
6. Create First Invoice — Set up invoice template, create and send first invoice
7. Add Contacts — Import or create first customer and supplier
8. Explore Reports — View P&L, Balance Sheet, run first report
9. Invite Team — Add users, set permissions

**Key difference from Xero:** Auto-detection of completion (not manual checkboxes), and sub-tasks navigate directly to the right place with contextual guidance.

#### A2: Demo Company Access

- Use the **existing demo company** already in the system
- All new users can switch to it via the CompanySwitcher to explore a fully populated environment
- Add a "Try Demo Company" CTA in the setup guide and on empty states
- No new data seeding required — leverage what's already built

#### A3: First-Use Contextual Wizards

When a user creates their first invoice, first contact, or first bank import — show a one-time setup wizard:

- **First Invoice:** Prompt for company logo, postal address, payment advice, invoice numbering prefix. Show live invoice preview (like Xero's modal)
- **First Contact:** Brief explainer of customer vs supplier, import option, fields guide
- **First Bank Import:** Format guide (CSV/OFX), column mapping helper, what to expect

These are **one-time modals** stored in user preferences, not blocking flows.

---

### WS-B: Dashboard Reimagination

**Priority: HIGH** — The dashboard is the daily landing page.

#### B1: Widget-Based Customizable Dashboard

Add an **adaptive widget grid** above the existing tabbed content (CoA, Journal Entries, Fiscal Periods, Reports).

**Design (improvement over Xero):**
- Xero's dashboard is customizable but layout options are limited (fixed grid, manual only)
- IsaFlow approach: **Usage-adaptive widget grid** that auto-populates based on each user's activity patterns
- System tracks module usage frequency and recency, then ranks widgets accordingly
- Heavy invoicing users see AR widgets prominently; heavy reconciliation users see banking widgets
- New users get Setup Guide + Quick Actions + AI Insights by default
- Users can still drag-reorder, add/remove, and resize manually — manual overrides persist
- "Reset to suggested" button restores the adaptive layout
- See Section 9 for full adaptive system detail

**Available widgets:**
| Widget | Description |
|--------|-------------|
| Bank Summary | Statement balance vs GL balance per account (like Xero) |
| Invoices Owed | AR summary: awaiting payment, overdue, 30/60/90 |
| Bills to Pay | AP summary: awaiting payment, overdue, 30/60/90 |
| Cash Position | Cash in/out chart (last 30/60/90 days) |
| P&L Snapshot | Current month/YTD P&L with trend sparkline |
| Tasks & Reminders | Upcoming tasks, overdue items, approval requests |
| Recent Activity | Last 10 transactions across all modules |
| AI Insights | Anomaly alerts, forecast summary, smart suggestions |
| Quick Actions | Create invoice, record payment, new journal, import statement |
| VAT Summary | Current VAT period status, upcoming return deadline |
| KPI Cards | Configurable financial ratios (current ratio, debt ratio, etc.) |
| Setup Guide | The onboarding checklist (WS-A1) as a widget |

**Key difference from Xero:** Drag-and-drop layout, AI insights widget, VAT/SARS compliance widget, configurable KPI cards — none of which Xero has.

#### B2: Quick Actions Bar

Add a persistent quick-actions section below the nav:
- "+" button in the nav (like Xero's "Create new") that opens a dropdown
- Options: New Invoice, New Bill, Record Payment, New Journal, Import Statement, New Contact
- Keyboard shortcut: `N` then first letter (e.g., `N I` for new invoice)

---

### WS-C: UI Foundation — Shared Component Library

**Priority: HIGH** — Foundation for all other improvements.

#### C1: Shared UI Primitives + Component Showcase

Currently IsaFlow has **no shared UI components** — every page writes its own buttons, inputs, modals inline. This creates inconsistency and makes design changes expensive.

**Step 1:** Build a **Component Showcase Page** (`/accounting/components`) — a living style guide where all components are rendered, documented, and tracked. See Section 10 for full detail.

**Step 2:** Create `src/components/ui/`:
| Component | Notes |
|-----------|-------|
| `Button.tsx` | Primary, secondary, ghost, danger variants. Loading state. Icon support. |
| `Input.tsx` | Text, number, date, search variants. Error/success states. Prefix/suffix slots. |
| `Select.tsx` | Searchable dropdown. Multi-select variant. Uses Radix. |
| `Modal.tsx` | Consistent modal shell with header, body, footer. Sizes: sm, md, lg, xl, full. |
| `Badge.tsx` | Status badges (draft, approved, paid, overdue, etc.) with semantic colors. |
| `Card.tsx` | Content card with optional header, footer, hover state. |
| `EmptyState.tsx` | Illustration + title + description + CTA button. Multiple illustration presets. |
| `Table.tsx` | Sortable, filterable table shell with pagination. |
| `Tabs.tsx` | Horizontal tabs with URL sync. Underline and pill variants. |
| `Toast.tsx` | Success/error/warning notifications. Auto-dismiss. |
| `Tooltip.tsx` | Simple tooltip wrapper. |
| `Drawer.tsx` | Slide-in panel from right (for setup guide, details, etc.) |
| `Skeleton.tsx` | Loading skeleton shapes (text, card, table row). |
| `Avatar.tsx` | User/company avatar with initials fallback. |
| `ProgressBar.tsx` | Linear progress with percentage label. |
| `Combobox.tsx` | Typeahead search input with dropdown results. |

**This is the single most impactful workstream** — it enables consistent design across 100+ pages and makes all subsequent UX work faster.

#### C2: Shared EmptyState Component

Every module should use a consistent empty state pattern:
- Custom illustration per module (simple SVG, not complex like Xero's)
- Clear heading ("No invoices yet")
- Description ("Create your first invoice to start tracking sales")
- Primary CTA button ("Create Invoice")
- Secondary link ("Import from CSV")
- Optional: "Watch how" video link

---

### WS-D: Navigation & Information Architecture

**Priority: MEDIUM** — Current nav works but could be improved.

#### D1: "Create New" Quick Menu

Add a "+" button in the header nav (like Xero) that opens a dropdown:
- New Invoice
- New Bill / Supplier Invoice
- New Quote
- New Payment
- New Journal Entry
- New Contact
- Bank Transfer

This is **separate from the command palette** — it's a mouse-friendly quick-create menu.

#### D2: Contextual Settings Links

Xero puts a settings gear icon in each nav dropdown (Sales settings, Purchases settings, etc.).

Add settings links to IsaFlow's nav flyouts:
- Customers flyout: "Customer Settings" link
- Suppliers flyout: "Supplier Settings" link
- Banking flyout: "Banking Settings" link
- VAT flyout: "VAT Settings" link

These deep-link to the relevant tab in Company Settings.

#### D3: Breadcrumb Navigation

Add consistent breadcrumbs on all sub-pages:
- Dashboard > Customers > Customer Invoices > INV-0042
- Dashboard > Banking > Bank Reconciliation > Brighttech (xxxx5895)

Use a shared `Breadcrumb` component from the UI library.

---

### WS-E: Invoice & Document Experience

**Priority: MEDIUM** — Invoicing is a core daily workflow.

#### E1: Invoice Preview

Add a "Preview" button next to "Save & Close" that opens a modal showing the invoice as it would appear to the customer (PDF-like render).

**Improvement over Xero:** Xero's preview opens a new page. IsaFlow's preview is an inline modal with zoom/scroll, plus a "Send from here" option.

#### E2: Combined Action Buttons

Like Xero's "Approve & email" split button:
- "Save & Close" (default) with dropdown: Save & New, Save & Email, Save as Draft
- Clear visual distinction between draft and approved states

#### E3: Discount Column on Invoice Lines

Add an optional "Disc. %" column to invoice line items (Xero has this).
- Hidden by default, shown via "Columns" toggle
- Calculates discount per line, shows in Amount

---

### WS-F: Organisation Settings Enhancement

**Priority: LOW** — Current settings cover the essentials.

#### F1: Additional Org Fields

Add fields that Xero has but IsaFlow doesn't:
- Industry (searchable dropdown)
- Business structure (Sole Proprietor, Partnership, Pty Ltd, etc.)
- Social media links (Facebook, LinkedIn, Twitter/X)
- Physical address with "Same as postal" checkbox

#### F2: Online Invoice Display Toggle

Like Xero's "Display additional details on your online invoices" toggle — let users choose which company fields appear on documents (registration number, VAT number, directors, etc.).

---

### WS-G: Reports Enhancement

**Priority: LOW** — IsaFlow already has excellent reporting.

#### G1: Report Favouriting

Add a star/favourite system for reports:
- Favourited reports appear at the top of the Reports page
- Stored per-user
- Quick access from dashboard widget

#### G2: Report Categories with Descriptions

Like Xero's "Show descriptions" toggle — add a brief description under each report name on the Reports hub page. Toggle on/off.

---

## 4. What We Are NOT Doing

To be clear, these Xero features are **out of scope** because they don't align with IsaFlow's strategy or we already have better alternatives:

| Xero Feature | Why We Skip It |
|--------------|----------------|
| Xero's visual design/branding | IsaFlow has its own identity |
| App marketplace | Not relevant at current stage |
| Xero Network (e-invoicing) | SA e-invoicing standards not yet mandated |
| Payroll (Xero-native) | We integrate with SimplePay/PaySpace |
| Projects module | We have time tracking; full project management is out of scope |
| Promotional banners/discount codes | Not applicable |
| "Preview with example data" as toggle | We'll implement as demo company instead (WS-A2) |

---

## 5. Implementation Priority & Phasing

### Phase 1: Foundation (Weeks 1-3)
| ID | Workstream | Effort | Impact |
|----|-----------|--------|--------|
| C1 | Component showcase page + shared UI library | HIGH | Critical enabler for all other work |
| C2 | Shared EmptyState component | LOW | Quick win, improves every empty page |
| D3 | Breadcrumb component | LOW | Quick consistency win |

### Phase 2: Onboarding & Dashboard (Weeks 4-6)
| ID | Workstream | Effort | Impact |
|----|-----------|--------|--------|
| A1 | Setup guide checklist | MEDIUM | High retention impact |
| B1 | Widget-based dashboard | HIGH | Daily experience improvement |
| B2 | Quick actions bar / "+" menu | LOW | Convenience improvement |
| D1 | "Create New" quick menu | LOW | Convenience improvement |

### Phase 3: Polish & Details (Weeks 7-9)
| ID | Workstream | Effort | Impact |
|----|-----------|--------|--------|
| A3 | First-use contextual wizards | MEDIUM | Onboarding improvement |
| E1 | Invoice preview | MEDIUM | Workflow improvement |
| E2 | Combined action buttons | LOW | Convenience |
| D2 | Contextual settings links | LOW | Navigation improvement |
| G1 | Report favouriting | LOW | Convenience |

### Phase 4: Nice-to-Have (Weeks 10+)
| ID | Workstream | Effort | Impact |
|----|-----------|--------|--------|
| A2 | Demo company access CTAs | LOW | Onboarding improvement |
| E3 | Discount column | LOW | Feature parity |
| F1 | Additional org fields | LOW | Completeness |
| F2 | Online invoice display toggle | LOW | Flexibility |
| G2 | Report descriptions | LOW | Discoverability |

---

## 6. Success Metrics

| Metric | Target |
|--------|--------|
| Setup guide completion rate | >60% of new users complete all 9 steps |
| Time to first invoice | <10 minutes from signup |
| Dashboard daily engagement | >80% of active users visit dashboard daily |
| UI consistency score | 100% of pages using shared components |
| Empty state conversion | >30% of users click CTA on empty states |

---

## 7. Technical Considerations

- **Shared component library (C1)** should use CVA (class-variance-authority) patterns already in the codebase
- **Component showcase page** built as a standalone page within the app — not a separate tool like Storybook
- **Widget dashboard (B1)** can use `react-grid-layout` for drag-and-drop
- **Adaptive widget system** needs a `user_activity_stats` table or extend `user_preferences` to track module usage counters
- **Setup guide (A1)** state stored in `user_preferences` table, completion events fired from existing API calls
- **Demo data (A2)** uses existing demo company — no new migration required
- **First-use wizards (A3)** store dismissal state in `user_preferences`, with reset option in settings
- **All components** must support dark mode via existing Tailwind `dark:` classes

---

## 8. Decisions (Resolved)

1. **Dashboard layout:** Widgets first at the top, then the existing tabbed content (CoA, Journal Entries, Fiscal Periods, Reports) below. Widgets are **adaptive** — the system tracks which features/modules each user interacts with most and auto-populates their widget layout accordingly. Users can still manually rearrange, but the default is intelligent per-user.

2. **Demo data:** Use the existing demo company that's already in the system. All new users can access and play around with it. No new seeding or migration required.

3. **Component library approach:** Build a **standalone component showcase page** (`/components` or similar) — a living style guide / storybook-style page within the app where all shared components can be viewed, tested, and tracked. This becomes the source of truth before retrofitting existing pages.

4. **First-use wizards:** Skippable, but **re-triggerable from settings**. Users can find them under Settings > "Setup Wizards" or similar, with a "Run again" button for each wizard.

---

## 9. Adaptive Widget System — Detail

The dashboard widget system is a key differentiator over Xero. Rather than a static layout or purely manual customization, IsaFlow's widgets are **usage-adaptive**:

### How It Works

1. **Activity tracking:** The system logs module visits and action counts per user (lightweight — just increment counters in `user_preferences` or a `user_activity_stats` table):
   - Pages visited (customers, suppliers, banking, reports, etc.)
   - Actions taken (invoices created, payments recorded, reconciliations completed, etc.)
   - Frequency and recency weighting

2. **Auto-layout algorithm:** On first dashboard load (or when widgets are reset), the system ranks modules by usage score and populates the widget grid:
   - Heavy invoicing user → "Invoices Owed", "Recent Payments", "AR Aging" widgets prominent
   - Heavy reconciliation user → "Bank Summary", "Unmatched Transactions", "Cash Position" prominent
   - Accountant user → "Trial Balance Summary", "Journal Activity", "VAT Summary" prominent
   - New user (no data) → "Setup Guide", "Quick Actions", "AI Insights" as defaults

3. **Manual override:** Users can drag-reorder, add, remove, or resize widgets at any time. Manual arrangement is persisted and overrides the auto-layout. A "Reset to suggested" button restores the adaptive layout.

4. **Widget library:** Full catalogue available via an "Add widget" button. Widgets are categorized:
   - **Financial:** Bank Summary, Cash Position, P&L Snapshot, KPI Cards
   - **Receivables:** Invoices Owed, AR Aging, Recent Payments
   - **Payables:** Bills to Pay, AP Aging, Upcoming Payments
   - **Activity:** Recent Activity, Tasks & Reminders, Approval Queue
   - **Intelligence:** AI Insights, Anomaly Alerts, Cash Flow Forecast
   - **Compliance:** VAT Summary, SARS Deadlines, Setup Guide

---

## 10. Component Showcase Page — Detail

A standalone page at `/accounting/components` (or `/dev/components` in dev mode) that serves as a living design system:

### Structure
- Sidebar with component categories (Buttons, Inputs, Modals, Cards, Tables, etc.)
- Each component shown with:
  - All variants rendered side-by-side (primary, secondary, ghost, danger, etc.)
  - All sizes (sm, md, lg)
  - All states (default, hover, focus, disabled, loading, error)
  - Dark mode toggle to preview both themes
  - Copy-pasteable usage code snippet
  - Props table with types and defaults
- **Completion tracker** at the top: "14 of 22 components built" with progress bar
- Links to which pages use each component (usage map)

### Why This Matters
- Single source of truth for the design system
- Makes it easy to spot inconsistencies
- Onboards new developers instantly
- Tracks migration progress as old pages adopt shared components

---

*This document is APPROVED. Implementation begins with Phase 1: Component Library & Showcase Page.*
