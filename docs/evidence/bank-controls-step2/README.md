# Bank controls step 2: evidence (2026-10-09)

## Browser acceptance (`01`–`08`)

These ran against `next dev` on a disposable fixture DB (`isaflow_schema_fixture` at migration 877). The fixture
company "Karoo Traders (Pty) Ltd" and its two users are fictitious:

- Alex Mokoena, admin;
- Bongi Dlamini, owner.

Both users have locally signed sessions. Switches on: `manual_journal` (one rule, "Journals over R1 000", owner) and
`bank_rule`. Nothing ran on `isaflow_dev`, because sessions there may be minted for the QA user only.

| # | What happened | Screenshot |
|---|---|---|
| 1 | Alex edits "FNB monthly fees" to auto-post. The change is held: Alex sees it under Pending changes with "Waiting for another member…", and the rule stays Suggest with a Pending approval badge. | `01-rule-change-pending-proposer.png` |
| 2 | Bongi sees the same pending change with Approve / Reject. | `02-rule-change-pending-approver.png` |
| 3 | Bongi approves. The change applies and the rule now shows Auto-post. | `03-rule-change-approved.png` |
| 4 | Alex transfers R25 000 from Cheque to Savings. It is saved as a draft journal awaiting owner approval, with links to the journal and to Approvals; nothing posts. | `04-transfer-awaiting-approval.png` |
| 5 | Alex (admin) switches auto-post on. The server refuses (403 `WEAKENING_REQUIRES_AUTHORITY`) and the page shows its message and keeps the stored values. | `05-auto-post-settings-refused.png` |
| 6 | Alex accepts an allocation on a line of a statement Alex imported (batch `imported_by` = Alex, channel `upload`). Refused 403 `IMPORTER_MAY_NOT_ALLOCATE`, with the way out. | `06-importer-may-not-allocate.png` |
| 7 | Bongi accepts the same line, and it allocates (200). | `07-another-member-allocates.png` |
| 8 | Bongi's Approvals page lists the held transfer journal (JE-2026-00001, R25 000) requested by Alex. | `08-transfer-request-in-approvals.png` |

## Other evidence

- `prod-topology-877.txt`: migration 877 applied as a NON-superuser deploy role that inherits a non-superuser owner,
  the topology that refused 872 on prod.
- `mutation-a.txt` (importer ≠ allocator, reversals), `mutation-b.txt` (bank-rule history and approval),
  `mutation-de.txt` (auto-post settings, transfers). For each, every guard was neutralised, a named test went red, and
  the guard was restored.
