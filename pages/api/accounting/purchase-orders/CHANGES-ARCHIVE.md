# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-11-03: budgets P5-3 — `[id]/approve.ts` (the only way to approve; stamps `approved_by`/`approved_at`, budget check, audit), the PUT's status allow-list, line CC1/CC2/BU on the PUT and the flat POST, the GET's lines labelled (`cc1_label`/`cc2_label`/`bu_label`, masters joined on id AND company).
- 2026-09-26: R-129 — `[id].ts` DELETE re-checks `status = 'draft'` in the DELETE's WHERE (same shape as R-126). Before, an order submitted between the status read and the DELETE was hard-deleted. The detail page (`pages/accounting/purchase-orders/[poId].tsx`) now shows the API's refusal message instead of swallowing it.
- 2026-09-25: R-126 — `[id].ts` PUT re-checks the status in the UPDATE's WHERE (K-137 pattern). Before, an order approved between the status read and the UPDATE still took the edit.
- 2026-09-24: `[id].ts` PUT checks each replacement item's `gl_account_id`, except that each account is exempt up to the number of lines the PO already had on it (the PUT replaces all lines, so an untouched line on a since-deactivated account must not block an unrelated edit, but an EXTRA line on that account is new and is refused) with `gl/documentLineAccountGuard.assertDocumentLineAccounts` before the `po_items` DELETE+INSERT — refuses an inactive or another company's account (400, nothing written). Closes the "Known limit" a GL account merge left open for PO lines (see `gl/.claude.md`).
- 2026-04-24: PR-8 L-tier IDOR code-smell cleanup
- 2026-04-20: UUID guard on PO [id], use `gl_account_id` in custom reports
- 2026-04-18: codemod handlers onto withAuth / withUserAuth
- 2026-04-18: P3 batch — 3-way match dropdowns, real CoA/Fiscal pages, AFS tab content
