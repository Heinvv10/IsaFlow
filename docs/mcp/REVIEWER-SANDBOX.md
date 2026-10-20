# Marketplace reviewer sandbox

`scripts/sandbox/reviewer-sandbox.ts` creates a fictional company, **IsaDemo Reviewer
Sandbox (Fictional)**, with one reviewer sign-in that reaches only that company, and the
MCP connector switched on for it. Marketplace reviewers (Grok Bot / Cursor) use it to
test the connector against data that belongs to nobody.

Every name in it is visibly fictional ("(Fictional)" / "Demo"), every email is
`@example.com`, and no ID, tax or bank number is stored.

## Rules

- `--apply`, `--rotate-password` and `--teardown` **write data**. Pointed at production
  they are production writes: run them only after the PR is merged, with Hein's explicit
  approval for that run, outside 08:00-17:00 SAST Mon-Fri, on Velo.
- The script never reads `.env.local` and never prints a secret. Export the variables it
  needs in the shell yourself.
- The reviewer password is generated at run time and written only to a mode-0600 file
  outside the repository (default `~/.isaflow-reviewer-credentials`). Copy it into the
  submission form yourself; never paste it into a doc, PR, log or chat.

## How to run

```bash
# 1. Look first. Writes nothing, needs no database.
bun scripts/sandbox/reviewer-sandbox.ts --dry-run

# 2. Create / update (idempotent; a re-run never changes the password).
export REVIEWER_SANDBOX_CONFIRM=fictional-reviewer-sandbox
export SANDBOX_OPERATOR_USER_ID=<users.id of a platform admin; signs the audit log>
export DATABASE_URL=... GOTRUE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
# optional: REVIEWER_SANDBOX_EMAIL (default marketplace-review@isaflow.co.za [VERIFY the mailbox]),
#           REVIEWER_SANDBOX_CREDENTIALS_PATH
bun scripts/sandbox/reviewer-sandbox.ts --apply

# New password (rewrites the credentials file):
bun scripts/sandbox/reviewer-sandbox.ts --rotate-password

# When the review is over:
bun scripts/sandbox/reviewer-sandbox.ts --teardown
```

## What it creates

- The company on the `professional` plan with **no subscription row**, so nothing is ever
  billed and no Flows are metered; the default chart of accounts and fiscal periods.
- The reviewer: a GoTrue user (email confirmed), platform role `viewer`, and exactly one
  company membership, role `manager` (so the role-fenced payroll tools are reachable once
  payroll data exists). No MFA factor.
- `mcp_connector` switched on for the company, audit-logged.
- Books, through the app's services: 5 customers, 3 suppliers, 8 customer invoices (2 paid
  through receipts, two over 60 days), 4 supplier invoices, 3 posted journals, and a bank
  account with 15 imported, unallocated lines.
- Not yet: payroll (employees and a finalised pay run).

## Guards (checked before anything is written)

1. The sandbox company id, if it exists, must belong to a company named
   "IsaDemo Reviewer Sandbox…".
2. The reviewer email must not belong to any other company.
3. After `--apply`, the reviewer has exactly one membership and a non-admin platform role.
4. Every name written must contain "(Fictional)" or the word "Demo".
5. No secret is printed (unit-tested).

## Teardown

`--teardown` revokes the reviewer's OAuth authorisations and personal access tokens,
removes the membership, deletes the GoTrue user, removes the `mcp_connector` override,
and deactivates the company. The fictional books stay in the deactivated company: posted
journals cannot be deleted, and `resetQaRecords` does not remove journals.

Tests: `tests/unit/scripts/reviewerSandbox.test.ts`,
`tests/integration/reviewer-sandbox.int.test.ts`.
