# Legal entity types

`companies.entity_type` holds one of eight South African entity codes. The list,
labels and rules live in one place, `src/lib/entityTypes.ts`. Migration 894 holds
the database to the same codes with a CHECK constraint (default `pty_ltd`).
Change the module and the CHECK together; `tests/unit/lib/entityTypes.test.ts`
fails if they drift.

| Code | Label | People | Required to finish onboarding | AFS template |
|---|---|---|---|---|
| `sole_proprietor` | Sole proprietor | the owner (one) | owner's ID document | none (pty fallback) |
| `partnership` | Partnership | partners (two or more) | each partner's ID document | none (pty fallback) |
| `pty_ltd` | Private company (Pty) Ltd | directors | CIPC registration certificate (COR14.3) | pty |
| `ltd` | Public company (Ltd) | directors | CIPC registration certificate | pty |
| `cc` | Close corporation (CC) | members | CK1 or CK2 | cc |
| `npc` | Non-profit company (NPC) | directors | CIPC registration certificate | pty |
| `trust` | Trust | trustees | Master's Letters of Authority | trust |
| `other` | Other | optional | nothing | none (pty fallback) |

Everything else (tax clearance, B-BBEE, VAT certificate) is optional for every type
(Hein, 2026-10-16).

**Registration number.** One column, `registration_number`, holds the CIPC number,
the CK number or the Master's reference (IT number). A sole proprietor and a
partnership have none.

**AFS.** The AFS engine has three templates, `pty`, `cc` and `trust`
(`AFS_TEMPLATE_KEYS`). `afsTemplateFor(entity_type)` picks one. A sole proprietor
or partnership is not a Companies Act entity, and the existing templates would
print directors and dividends for it, so those types have no template of their own
and keep the `pty` fallback the AFS code always used.

**History.** Migration 408 had squashed every value into the AFS keys
(`pty|cc|trust`) with a CHECK, while Company Settings offered `company`,
`sole_proprietor` and others that the CHECK refused. Migration 894 turned `pty`
(and NULL or a legacy `company`) into `pty_ltd` and kept `cc` and `trust`.
`business_structure` (migration 286), a second free-text copy of the same idea,
is no longer shown or edited in Company Settings. The column and its data remain.

**Where the proof rule is enforced (server-side).** `src/modules/onboarding/services/entityOnboardingRules.ts`
is the one rule set, shared by the wizard and the server:

- `POST /api/onboarding/complete-setup` creates the company, owner membership, chart,
  people and documents in one transaction, and only when `setupIssues` passes. A refusal
  or a failure leaves nothing behind.
- Every later change of `entity_type` (Company Settings, the AFS PIS score) passes
  `entityTypeChange.ts`, which judges what is stored: active documents and ID scans of
  at least 1 KB, people within the type's maximum, no duplicate partners.
- Migration 895 lets `company_documents` hold `ck_certificate` and `letters_of_authority`.

Known gaps (follow-ups, not enforced): proof can be removed after onboarding; the
signup placeholder company, admin create and waitlist promotion still create a
`pty_ltd` with no proof; a 1 KB file is not checked for being a real certificate.
