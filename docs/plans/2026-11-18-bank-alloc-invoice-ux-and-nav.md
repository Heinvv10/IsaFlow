# Bank allocation, invoice line items and navigation: fixes and plan

**Date:** 18 Nov 2026 · **Branch:** `fix/bank-alloc-invoice-ux-20261118` (off `origin/master` at `521682f65d`)
**Status:** In progress. All three decisions are made (section 7); workstream A is being built.

## 1. What was asked

Hein reported five problems on production (Velocity Fibre company) and then asked for advice on the top navigation:

1. Text overlap in the account picker when allocating a bank transaction.
2. "Validation failed" when selecting a cost centre (CC) on a bank transaction.
3. Bank transaction table is not usable on a smaller screen; descriptions are hidden.
4. Supplier invoice line items are cramped. Add CC1 under Dimensions. Use the page well in both nav modes.
5. Confirm the "Create new" shortcuts work.
6. The top menu layout feels clunky. What is the best layout?

## 2. How it was checked

| Check | Where | Notes |
|---|---|---|
| Live review | Production, Hein's Chrome session, 1919px wide | View only. No record was saved or changed. |
| Code trace | This worktree | Two read-only search agents, key lines re-read and re-run by hand. |
| Narrow widths | Local dev server on this worktree, dev database, headless Chromium | 1366, 1280, 1024 and 768px, top and sidebar modes. Chrome on Hein's machine is locked maximised and the app refuses framing, so production could not be resized. |
| Usage data | Admin web analytics, "App" site, last 90 days | One CSV export of raw page views, analysed in the page. It is recorded in the admin audit trail under Hein's login. |

## 3. Findings

### 3.1 Account picker text overlap: confirmed

- The account code sits in a fixed 40px column (`w-10 shrink-0`), sized for 4-digit codes.
- Velocity Fibre uses 8-digit codes (`49784365`), which run over the account name.
- `src/components/accounting/bankTx/BankTxSelectionCell.tsx:140` (suggested row) and `:154` (every other row).

### 3.2 CC select "Validation failed": cause found

- Picking CC1 calls `saveDimensions`, which posts `cc1Id`, `cc2Id` and `buId`, turning every empty value into `null` (`src/components/accounting/bank-transactions/bankTxSaveActions.ts:30`).
- The server schema is `UUID.optional()` for all three (`pages/api/accounting/bank-transactions-action.ts:113-115`). That accepts a valid ID or a missing field, and rejects `null`.
- Run against the real schema: the payload with two nulls fails; the same payload with the fields left out passes.
- Result: saving any single dimension fails. It only succeeds when all three are set. Clearing a value back to "—" also fails.
- The toast shows only "Validation failed"; the field-level detail the server returns is dropped (`src/lib/apiFetch.ts:115-129`).
- Both sides are old (client payload from March 2026, schema from April 2026). The November rollback work made the failure visible: the value now snaps back instead of looking saved until reload. That last sentence is an inference from commit messages.
- Not reproduced on production, because a successful attempt would write to live books.
- Existing tests always send three valid IDs, so they miss it (`tests/unit/api/bankDimensionAssignmentPolicy.test.ts:57`).
- To check during the fix: the accept/allocate action uses the same `.optional()` pattern (`bank-transactions-action.ts:61-63`).

### 3.3 Bank table on smaller screens: confirmed

Description is the only column without a fixed width, so it absorbs all the squeeze.

| Viewport | Nav mode | Content width | Description | Selection | Rule |
|---|---|---|---|---|---|
| 1627 (production) | top | 1532 | 89 | 216 | 126 |
| 1366 | sidebar | 1110 | 82 | 167 | 94 |
| 1280 | sidebar | 1024 | 82 | 140 | 72 |
| 1024 | sidebar | 768 | 82 | 101 | 40 |

- Description never gets more than about 90px, even on a wide screen, while Notes (103px), Rule (126px) and Actions (206px) hold space that is mostly empty.
- Below 1024px the table already becomes cards (earlier mobile work), so the gap is 1024 to about 1700px.

**Production is behind master (checked 18 Nov 2026).** Production runs `bb88e0a0c6`; master is 75 commits ahead. One of those is PR #1552 (bank layout: the eight row icons become a single "..." menu, 206px down to 66px), merged 17 Nov and not yet live. So part of what Hein saw is already fixed on master and ships with the next deploy. The numbers above are production; on master, before this branch, Description at his width with CC and BU shown is about 182px.

**After this branch (dev build, CC1, CC2 and BU columns shown):**

| Viewport | Nav mode | Description | Table fits without inner scroll |
|---|---|---|---|
| 1920 | top | 539 | yes |
| 1627 | top | 246 | yes |
| 1366 | top | 160 | yes |
| 1280 | top | 160 | no, scrolls inside its card (1240 in 1200) |
| 1627 | sidebar | 160 | yes |
| 1366 | sidebar | 160 | no (1240 in 1030) |

Description wraps to two lines and never drops under 160px; the row height stays 41px. The page itself never scrolls sideways.

### 3.4 Supplier invoice line items: confirmed

- The page is capped at 1152px (`max-w-6xl`, `pages/accounting/supplier-invoices/new.tsx:205`) with a fixed 320px summary column. On a 1919px screen about 700px is unused.
- The line table gets 764px. With Dimensions on, the description input is 74px at every width tested.
- The table has a 720px minimum (`BillLineItemsTable.tsx:143`), so on narrower layouts it scrolls sideways inside its card:

| Viewport | Nav mode | Card width | Table width |
|---|---|---|---|
| 1024 | top | 540 | 720 |
| 1366 | sidebar | 610 | 720 |
| 1280 | sidebar | 524 | 720 |
| 1024 | sidebar | 284 | 720 |

- The customer invoice page has the same cap (`pages/accounting/customer-invoices/new.tsx:211`).
- **CC1 is left out on purpose.** `BillLineItemsTable.tsx:3-4`: "the CC1 is derived from the CC2, never picked". Adding a CC1 picker changes that rule; showing the derived CC1 read-only does not.

### 3.5 Create new shortcuts: all seven work

Each N-combination was pressed on production and landed on the right screen. The menu items use the same routes, so clicks go to the same places (clicks were not individually tested).

| Item | Keys | Opens |
|---|---|---|
| New Invoice | N I | Customer invoice form |
| New Bill | N B | Supplier invoice form |
| New Quote | N Q | Quotes list with the New Quote pop-up |
| Record Payment | N P | Customer payment form |
| New Journal Entry | N J | Journal entry form |
| New Contact | N C | New customer form |
| Bank Transfer | N T | Bank transfers form |

- N opens the menu and the second key picks an item; there is no time limit. The keys are ignored while typing in a field.
- Possible surprises: "New Invoice" opens a customer invoice even from the Supplier Invoices page; "Record Payment" and "New Contact" cover customers only, although supplier payment and new supplier pages exist.
- No test presses the keys (`tests/unit/components/createNewMenuRoutes.test.ts` checks routes only).

### 3.6 Navigation

**Structure today (top mode)**

- Three stacked bars: header 56px, main nav 43px, section bar 44px. Content starts 143px down. In sidebar mode it starts at 56px.
- The section bar repeats what the main menu already has. Hovering Purchases opens five daily links, "Add a Supplier", and the same six groups as side fly-outs.
- The open main menu covers the section bar.
- "Suppliers" appears twice in the Purchases menu (a link and a group).
- Main menu items are sentence case; section-bar menu items are all capitals.
- The section bar is inconsistent: Sales, Purchases, Reports, Tax and Payroll have one; Banking does not.
- **Inventory, Accounting and Practice are not on the main row** (they sit under Library), so for those three the section bar is the only always-visible menu. Removing it everywhere would strand them. (`src/components/accounting/navSections/secondaryNav.ts:22-25`)
- Header holds two set-once controls permanently: row density (2 buttons) and theme (3 buttons).

**Narrow widths**

- Top mode fits down to 1024px: the last main-row item ends at 958px, leaving 66px. One more tab, or a longer label, would overflow.
- Sidebar mode costs 256px. At 1024px that leaves 768px of content, where the invoice form and bank table break down (tables in 3.3 and 3.4).
- At 768px both modes switch to the drawer menu and the header grows to 101px.

**Usage, 27 Aug to 18 Nov 2026 (2 997 page views, 210 visitors, 92% desktop)**

| Move between two pages | Count | Share |
|---|---|---|
| Same page or same record (reloads, list to detail) | 1 255 | 48% |
| Login, home and other pages outside the app shell | 593 | 23% |
| Settings and pages not mapped to a module | 444 | 17% |
| To or from the dashboard | 150 | 6% |
| Between sibling pages in one module | 94 | 3.6% |
| Between modules | 72 | 2.8% |

- No sibling pair dominates. The most common is bank import to bank transactions, 6 times in 90 days.
- Most-viewed app pages in the last 30 days: bank transactions 86, dashboard 75, user access 28.
- Limits of this data: visitors are an IP-and-browser hash with a 30-minute gap rule, the module mapping is by URL prefix and rough (the 17% unmapped bucket may hide some sibling moves), and it cannot show which control was used to navigate. Volume is low.

**Reading:** the always-visible section bar serves about 4% of moves and costs 44px on every page of five modules. The data supports removing it where the main row already carries the same groups.

## 4. Proposed changes

### Workstream A: functional fixes (one PR, this branch)

| # | Change | Files | Test first |
|---|---|---|---|
| A1 | Account code column sizes to its content, with a small minimum. The same fixed column is in the two split-allocation pickers, fixed too | `BankTxSelectionCell.tsx`, `EntityPicker.tsx`, `SplitLineRow.tsx` | Component test: an 8-digit code and its name do not overlap (code cell has no fixed width class) |
| A2 | Server accepts `null` for `cc1Id`, `cc2Id`, `buId` on `save_dimensions`; check the allocate action for the same gap | `bank-transactions-action.ts` | API test posting the exact client payload (one ID, two nulls) expects 200; clearing to null expects 200 |
| A3 | ~~Show the server's field detail in the toast when validation fails~~ Dropped from this PR: the helper (`assertOk`) is shared by every screen and is covered by the error-wording test suites, so changing it belongs with that work. With A2 fixed this case no longer occurs. | n/a | n/a |
| A4 | Bank table: Description gets a minimum width and wraps to two lines; Notes and Rule shrink | bank table header and row cells under `src/components/accounting/bankTx/` | Browser test at 1280 and 1366: Description is at least 200px and the full text is reachable |
| A5 | Invoice line items: remove the 1152px cap, give Description a floor, stop the sideways scroll at 1024 to 1366 | `supplier-invoices/new.tsx`, `BillLineItemsTable.tsx`; same for customer invoice if agreed | Browser test at 1024, 1280, 1366 in both nav modes: description input at least 180px, no inner horizontal scroll |
| A6 | CC1 on supplier invoice lines | `BillLineItemsTable.tsx` | Depends on decision 7.1 |

A2 is the only server change. No migration.

### Workstream B: navigation (separate PR, after A)

| # | Change | Risk |
|---|---|---|
| B1 | Remove the section bar for modules that are on the main row (Sales, Purchases, Reports, Tax, Payroll). Keep it for Inventory, Accounting and Practice | Touches `AppLayout`, `shellHeights`, `ShellSkeleton` and the golden shell specs. Six nav fixes landed in the last three weeks, so this area is sensitive. |
| B2 | Sentence case in every nav menu; remove the duplicate "Suppliers" entry | Low |
| B3 | Move density and theme toggles into the Settings menu | Low. They already live in a menu below 1024px. |
| B5 | Create new menu holds only the most used and most important actions (list below) | Low. Route test and the 390px menu test need updating; add a test that presses the keys. |
| B4 | Replace the fly-out menu with one panel per module: daily links on the left, groups as columns, a "Recent" column | Largest piece. Must fit 1024px. Reports has 9 groups and needs two rows. |

B1 to B3 give most of the benefit (44px back, one menu instead of two, consistent text). B4 is the redesign and is parked (decision 7.3).

**B5: Create new menu, agreed contents**

Views of create screens, 27 Aug to 18 Nov 2026 (all companies; about eight of these views are from this review):

| Create screen | Views | Visitors | In menu today |
|---|---|---|---|
| New customer | 29 | 7 | Yes, as "New Contact" |
| New supplier invoice | 12 | 3 | Yes, as "New Bill" |
| New customer invoice | 9 | 3 | Yes |
| New purchase order | 7 | 2 | No |
| New bank reconciliation | 6 | 3 | No |
| New employee | 5 | 4 | No |
| New supplier | 4 | 2 | No |
| Customer payment | 3 | 2 | Yes |
| Journal entry | 3 | 2 | Yes |
| New quote | 3 | 1 | Yes |
| Bank transfer | 1 | 1 | Yes (the one view is from this review) |
| Supplier payment | 0 | 0 | No |

Agreed menu (seven items): New Invoice (I), New Bill (B), New Purchase Order (O), New Customer (C), New Supplier (S), Record Payment (P), New Journal Entry (J).

- Renamed: "New Contact" becomes "New Customer", since that is what it opens.
- Added: New Purchase Order, New Supplier.
- Removed: New Quote, Bank Transfer. Both stay reachable from their module menus.
- Kept on importance despite low counts: Record Payment and New Journal Entry.
- The counts are small, so this is a judgement backed by thin data.

### Not in scope

- Any change to mobile card layouts below 1024px.
- Any change to how CC1 is derived on posting.

## 5. Order of work

1. A2 and A3 (the functional bug), then A1.
2. A4 and A5 (layout), with browser checks at 1024, 1280, 1366 and 1919 in both nav modes.
3. A6 once 7.1 is answered.
4. PR for workstream A. Gate: `bun run ci`, blind `/review`, then `mq-isa add`.
5. Workstream B as its own PR, in the order B1, B2, B3, B5.

Production deploy is a separate step that needs Hein's approval and happens after hours.

## 6. How we know it worked

- A2: selecting CC1 alone on an unallocated bank line saves and survives a reload (dev first, then production after deploy).
- A1: an 8-digit account code and its name are both fully readable in the picker.
- A4: at 1366px in sidebar mode a typical bank description is readable without hovering.
- A5: at 1280px in sidebar mode the line item description shows at least 20 characters with Dimensions on, and the card does not scroll sideways.
- B1: content starts at 99px in top mode on Purchases pages, and no page loses its only route to a sibling page.

## 7. Open decisions

1. ~~**CC1 on invoice lines.** Show the derived CC1 read-only (keeps today's rule), or make it pickable (changes the rule)?~~ **Decided 18 Nov 2026 (Hein):** read-only. Show the CC1 that will apply beside the CC2 picker; the derivation rule does not change.
2. ~~**Create new menu.** Leave as is, or add supplier options (pay a supplier, new supplier)?~~ **Decided 18 Nov 2026 (Hein):** "just the most important functions or most used should be there". The seven-item list in B5 was confirmed by Hein the same day.
3. ~~**Navigation depth.** Stop at B1 to B3, or also build the panel (B4)?~~ **Decided 18 Nov 2026 (Hein):** stop at B1 to B3. B4 is parked and only revisited if the nav still feels clunky afterwards.

## 8. Not verified

- The CC error was not reproduced on production; the cause is from code and from running the schema.
- Narrow widths were viewed on the dev build of `origin/master` with dev data, not on production. Dev shows an extra 37px banner that production does not.
- The bank table in top mode at narrow widths was not measured (the page had not finished loading when the capture ran); sidebar-mode numbers are above.
- Create new items were tested by keyboard, not by click.
- No tests have been run and no code has been changed.
