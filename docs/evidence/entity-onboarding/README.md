# Entity-first onboarding and admin company links: browser acceptance

Result: all 8 scenarios PASS. Playwright (Chromium), synthetic data only, run against the worktree at head 5dc241293
(the UI-fix commit). Script: `scripts/acceptance/entity-onboarding.ts` (set `ACCEPT_SCRATCH` to a directory holding a session signer).
This directory holds exactly **46 PNG files** plus this README.

## Setup

- Each onboarding user is seeded like a real signup: a placeholder company ("Synth Signup N") plus an owner
  membership, with `sb-access-token` (aal2) and `active_company_id` cookies. A fresh placeholder id is used per run.
- Manual entry only (no VLM). Uploading an ID shows "AI extraction unavailable." and keeps the typed name and ID number.
- SA ID numbers are generated in code with a valid Luhn digit. Test PDFs and PNGs are padded to about 2 KB (the server
  refuses files under 1 KB) and are byte-unique (the server refuses the same file attached twice).
- Dark mode is the `dark` class on `<html>` (default dark); the script toggles it. Mobile is 390px wide, desktop 1440px.
- Admin pages are reached as `http://admin.isaflow.co.za` mapped to the dev server with `--host-resolver-rules`, because on
  `localhost` the middleware redirects `/admin/*` to a path that 404s.
- Admin screenshots are desktop only: the admin mobile layout is pre-existing and broken (the sidebar does not collapse).

## Onboarding results (DB checked on the NEW company, not the placeholder; after finishing, `active_company_id` points at it)

| # | Entity | Flow | DB result |
|---|---|---|---|
| 1 | sole_proprietor | "Synth Plumbing", owner with ID document, no company-document slot, finishes | `sole_proprietor`, owner link, 1 Owner person, no documents |
| 2 | partnership | "Synth Partners", 2 partners each with an ID document, finishes | `partnership`, owner link, 2 Partner people, no documents |
| 3 | pty_ltd | Continue disabled without the CIPC Registration Certificate and the reason is shown; then finishes with one | `pty_ltd`, owner link, `cipc_certificate` |
| 4 | cc | "Synth Builders CC", CK1 / CK2 Founding Statement, finishes | `cc`, owner link, `ck_certificate` |
| 5 | trust | "Synth Family Trust", Master's Letters of Authority, finishes | `trust`, owner link, `letters_of_authority` |

For each, the run also asserted: the entity step shows the hint (people label and required proof); the details step shows
the people label; the POST to `/api/onboarding/complete-setup` returned 200; the browser landed on `/accounting`, which showed
the new company's name, with the tour skipped if present and no skeleton left (the only remaining `animate-pulse` element
is the notification-count badge button, not a skeleton).

## Admin results (Thandi Synth)

| # | Scenario | Result |
|---|---|---|
| 6 | ISAFlow Demo: select accountant (the button "Save role" appears, DB still bookkeeper), then Save role | `company_users.role` = accountant |
| 7 | ISAFlow Demo: Remove shows "Remove this link?" with Confirm remove and Cancel; Confirm remove | no `company_users` row remains |
| 8 | Synth Solo Owner: Remove, Confirm remove | HTTP 409 "Cannot remove the last owner of the company", shown on screen; link row count still 1 |

(The ISAFlow Demo link is re-inserted as bookkeeper before #6, because a previous run removed it.)

## Measurements (assertions in code, not screenshot claims)

- No page-level horizontal scroll at 390px: `document.documentElement.scrollWidth <= innerWidth` was measured as 390 / 390 on
  every step (entity, details, steps 3 to 8, review) for each of the five entity types (45 measurements, all OK).
- ID number input at 390px (asserted `scrollWidth <= clientWidth` and a 13-digit value): sole proprietor owner 280 / 280;
  partnership partner 1 280 / 280; partnership partner 2 280 / 280.
- Light-mode computed styles on the entity step: logo filter `brightness(0)` (black) on page background
  `rgb(248, 250, 252)`; card label `rgb(15, 23, 42)`, hint `rgb(75, 85, 99)`; selected card border `rgb(20, 184, 166)`.

## Screenshots (what each set shows)

| Files | Shows |
|---|---|
| `01-sole-prop-entity-step-*` (2) | the eight entity cards with Sole proprietor selected (desktop light, mobile dark) |
| `01-sole-prop-details-people-*` (2) | business details and the Owner row with ID document attached (mobile light, desktop dark) |
| `01-sole-prop-docs-step-*` (4) | documents step with "Captured on the Owner step", optional documents, in all four combinations |
| `01-sole-prop-landed-*` (1) | accounting dashboard for Synth Plumbing, desktop dark |
| `02-partnership-entity-step-*`, `02-partnership-docs-step-*` (2 each) | entity cards and documents step |
| `02-partnership-details-people-*` (2) | both partners stacked at 390px with the full 13-digit ID numbers visible (mobile light, mobile dark) |
| `02-partnership-landed-*` (1) | accounting dashboard for Synth Partners, desktop dark |
| `03-pty-ltd-entity-step-*`, `03-pty-ltd-details-people-*` (2 each) | entity cards; details with the Directors label |
| `03-pty-ltd-blocked-no-cipc-*` (4) | documents step with Continue dimmed and the line "Upload the CIPC registration certificate (COR14.3) to continue." under it, mobile and desktop, light and dark |
| `03-pty-ltd-docs-uploaded-*`, `03-pty-ltd-landed-*` (1 each) | CIPC certificate attached (desktop light); accounting dashboard for Synth Holdings (Pty) Ltd (desktop dark) |
| `04-cc-*`, `05-trust-*` (entity step 2, details 2, docs uploaded 2 each) | the same views for CC (CK1 / CK2) and trust (Letters of Authority) |
| `06-admin-role-dirty-*` (2) | Linked Companies with the role select changed to Accountant and the Save role button visible (desktop light and dark) |
| `06-admin-role-saved-*` (1) | after saving, desktop light |
| `07-admin-remove-confirm-*` (2) | "Remove this link?" with Confirm remove and Cancel (desktop light and dark) |
| `07-admin-remove-done-*` (1) | after removal, desktop dark |
| `08-admin-last-owner-refused-*` (2) | the refusal message for the last owner (desktop light and dark) |

## Observations (not failures)

- In light mode the admin sidebar items render very pale (see `06-admin-role-dirty-desktop-light.png`).
- In light mode the teal "Upload" links are pale on white.
- Earlier-run companies stay in the throwaway DB (`entity_changes` is append-only); each run clears the user's memberships first.
