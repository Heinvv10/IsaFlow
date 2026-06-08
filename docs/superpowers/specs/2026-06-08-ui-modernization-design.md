# IsaFlow UI/UX Modernization — Design

**Date:** 2026-06-08
**Status:** Approved (design) — ready for implementation planning
**Scope of this spec:** Full vision documented for context; **Phase 1–2 specified concretely**, Phases 3–6 captured as sequenced roadmap.

---

## 1. Problem

IsaFlow is a feature-complete accounting SaaS, but its UI feels dated — "like QuickBooks or Sage." Diagnosis: the *plumbing* is already modern (command palette, keyboard nav, dark mode, PWA, density toggle, CSS-custom-property theming). The dated feeling comes from the **information architecture**, which faithfully traces 2005-era desktop accounting software:

- **Module-first, not work-first.** Twelve top-level tabs (Sales, Purchases, Banking, …) make the front door a filing cabinet. The user must know which module a task lives in before they can start.
- **Form-and-list round-trips.** The dominant interaction is list → New → full-page form → save → back. Every task is a navigation journey.
- **Shows the system, not the situation.** Users land on a metrics dashboard, then go hunting.

Notably, the antidotes already exist but are buried: `Portfolio Workbench` and `Month-End Workbench` are work-oriented surfaces sitting as peer tabs. The instinct is right; the centre of gravity has not shifted.

## 2. Primary user (the fork that shapes everything)

**Both, firm-led.** Design the practitioner surface first as the core product, then expose a simplified client/owner view on the same engine. This matches the real user mix: bookkeeping firms (e.g. Marneweck) *and* direct clients (e.g. Britech).

## 3. Design decisions

### 3.1 Two-level navigation (work-first)

**Level 1 — Practice cockpit** (firm users land here on login):
- A **deadline-aware, cross-client work queue**. Aggregates real, actionable tasks across all clients ("approve 9 bills spanning 4 clients"), so a bookkeeper can work without entering each client.
- Ranked/colour-coded by **compliance calendar** urgency (VAT, payroll, month-end close).
- Status strip: clients needing work, VAT due ≤7d, unreconciled txn count, month-end progress (e.g. 5/12 closed).
- Client triage list with R/A/G status; click a client → drop into its Level 2 home.
- **Direct clients skip Level 1** and land on their own Level 2 home.

**Level 2 — Client home (hybrid):**
- Thin **glanceable-metrics strip** (3–4 numbers: revenue MTD, cash, AR, AP) for reassurance.
- Below it, a prioritised **"needs you" feed**: bank txns to reconcile, bills to approve, overdue customers to chase, VAT due. Each feed item has an inline primary action; the user acts *from* the feed.

**The 12 existing modules** survive behind a **"Library"** drill-down for full-ledger work — demoted from front door to reference.

### 3.2 Reconciliation — the heartbeat

Where bookkeepers spend most of the day; most differentiating surface.
- **Engine:** AI auto-posts the confident ~90% silently.
- **Default surface:** keyboard **row-stream** with one-key accept (Enter accepts the suggested category/match; E edit; S split). Learns from corrections.
- **Power toggle:** **spreadsheet grid** for bulk/Excel-minded users (tab/arrow, fill-down, multi-select-and-post).
- Only genuinely uncertain items require human decision.

### 3.3 Create/edit interaction

Replace full-page form round-trips with:
- **Side panel sliding over the list** — list stays visible, context preserved.
- **Click-to-inline-edit** rows.
- **"Save & new"** for fast repeat entry.

### 3.4 AI posture (phased)

- **Now:** AI assists *quietly* — inside recon/coding only (§3.2).
- **Phase 2 (later):** persistent **"ask anything" natural-language bar** ("what does Britech still owe over 60 days?" → inline answer) + **document inbox** (forward/snap a bill → AI reads, codes, queues for approval).

### 3.5 Visual language — one system, two themes

**Single design-token + component layer; two themes. Diverge tone & density, never fork the codebase.**

- Primitives (`Card`, `Money`, `ActionRow`, `Feed`, etc.) read tokens for density, font scale, radius, and tone-of-voice strings.
- **Practitioner theme = Dense:** compact spacing, monospace numerals, terse labels ("Reconcile 14"), keyboard hints. Linear/Bloomberg energy, throughput-first.
- **Client theme = Warm:** roomy spacing, serif display face, plain-language copy ("14 things to tidy up"), softer colour. Approachable; doubles as the firm's branded client-portal surface (retention/differentiation wedge).
- Same React components, same data, two token files. New features built once, inherit whichever skin the surface is under.
- **Builds on the existing pattern:** `AppLayout` already consumes CSS custom properties (`--ff-canvas-base`, etc.) — this extends that, not a new architecture.

## 4. Rollout (phased; not a big-bang rebuild)

This is a live, feature-complete product. Each phase ships independently and is usable on its own. The new shell runs **alongside** the existing nav behind a feature flag until proven.

1. **Phase 1 — Design system foundation.** Shared token + theme layer (Practitioner/Dense + Client/Warm) and component primitives (`Card`, `Money`, `ActionRow`, `Feed`, side-panel). No new screens yet; refactor a couple of existing surfaces onto the primitives to prove the themes.
2. **Phase 2 — Work-first shell.** Promote Portfolio/Month-End workbenches into the new **practice cockpit** (Level 1) + **client feed home** (Level 2), behind a flag, alongside the old nav. Modules reachable via "Library".
3. **Phase 3 — Reconciliation surface.** AI-auto-post engine + row-stream default + grid toggle.
4. **Phase 4 — Create/edit.** Side-panel + inline-edit pattern across high-traffic record types.
5. **Phase 5 — Client Warm theme + portal.** Ship the diverged client view.
6. **Phase 6 — AI surface.** "Ask anything" NL bar + document inbox.

**This spec specifies Phases 1–2 for implementation.** Phases 3–6 are roadmap and each warrants its own spec → plan cycle when reached.

## 5. Out of scope (YAGNI)

- Rebuilding the 12 module pages' internals (they become "Library"; their forms get the side-panel treatment in Phase 4, not now).
- The NL "ask anything" bar and document inbox (Phase 6).
- Any change to the data model, services, or API layer — this is a presentation/IA effort. Cross-client aggregation in the practice cockpit reads existing per-company data; multi-tenant `company_id` scoping rules are unchanged.

## 6. Success criteria

- A firm user lands on a cross-client cockpit and can action work across clients without manually entering each one.
- A client/owner lands on a calm, plain-language home that answers "am I okay?" and surfaces what needs them.
- Both surfaces are built from one component library with two theme files; a new feature is authored once.
- The new shell ships behind a flag without disturbing the existing module nav, which remains fully functional throughout.

## 7. Open questions for planning

- Exact token taxonomy and which existing CSS custom properties are reused vs. introduced.
- Feature-flag mechanism for the parallel shell (per-user? per-company? env?).
- Which 1–2 existing surfaces to refactor first in Phase 1 to prove the primitives.
- Practice-cockpit aggregation: query strategy for reading actionable counts across the firm's companies. Note IsaFlow is single-DB, `company_id`-scoped with RLS (`request.jwt.claims`) — a firm-level read spans multiple `company_id`s the user is entitled to, which the current per-company RLS/`withAuth` model is not yet shaped for. This needs a deliberate, still-tenant-safe access pattern.
