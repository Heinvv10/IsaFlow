# W17 — Live SARS ISV e-filing: written blocker (2026-11-25)

**Status: BLOCKED on SARS, not on code.** Master-plan wave 7, PR "ISV", ruling Q10 (blocker report only).
This document is the whole deliverable: no code, no flag, no credential storage, no stub. No agent submits
to SARS production, and no agent sends SARS traffic of any kind.

Source of every SARS claim below: `docs/sars/2026-07-VAT201-isv-dossier.md` (the "dossier"), section
numbers in brackets. Where the dossier says UNVERIFIED, so does this document.

## 1. Why it is blocked

Live VAT201 submission needs a wire protocol, a test endpoint and vendor credentials. SARS gives IsaFlow
none of them until IsaFlow is an authorised ISV:

- The VAT201 ISV spec is **not public**. The only public ISV spec is IBIR-006 (Tax Directives). Specs are
  "provided by SARS" after authorisation: ISV T&Cs v3 (21 Jun 2017) cl. 3.3.1 [dossier 1c].
- There is **no public sandbox**. Acceptance testing is mandatory (cl. 3.2.1), production activation needs
  SARS's prior written approval after it (cl. 3.1-3.2), and no interface change is allowed without prior
  testing and written approval (cl. 3.4.5). The name and mechanics of the VAT201 test environment are
  UNVERIFIED and are told to the vendor during onboarding [dossier 1d].
- `docs/sars/` contains no endpoint, schema, credential or test environment (checked on `origin/master`
  10f2af9185: only the dossier, the Central Tax Hub/Peppol spike, and `vat-returns-readers.md`).
- Protocol (SOAP vs REST, XML vs JSON), tax-period wire encoding, any per-submission PIN, and the status
  code enumeration are all UNVERIFIED and released with the spec [dossier 2b, 2c, 2d].

Building anything live now would mean inventing a wire format. That is a stub (repo rule "No stubs") and
the channel already carries one deliberately-confined provisional format (section 2).

## 2. What exists today (all dark)

| Piece | File (lines at 10f2af9185) | State |
|---|---|---|
| Submit/poll route | `pages/api/accounting/sars/efiling-submit.ts` (78) | POST `{submissionId, action: submit\|poll}`; `withAuth` + CSRF + write access; submit needs VAT/Tax Approve (`refuseWithoutApprove`); maps `EfilingNotConfigured/Blocked/AlreadyFiled/SendUncertain` errors |
| Status route | `pages/api/accounting/sars/efiling-status.ts` (20) | returns redacted `{configured, baseUrlHost, channel}`, never the key |
| Config gate | `reports/sarsEfilingConfig.ts` (87) | dark unless `SARS_EFILING_ENABLED=true` and `SARS_EFILING_BASE_URL`, `SARS_EFILING_ISV_LOGIN`, `SARS_EFILING_ISV_KEY` all set; https required in production. Process-wide env, not per company |
| Transport | `reports/sarsEfilingClient.ts` (147) | activation-key auth, submit, poll. **PROVISIONAL wire** (header `:9-18`), modelled on the documented mechanism; async submit -> correlationId -> poll |
| Orchestration | `reports/sarsEfilingSubmissionService.ts` (293), `sarsEfilingService.ts` (297) | server-side exceptions gate (`evaluateEfilingGate`) refuses to file a dirty return; idempotency (already-filed, send-uncertain); audit rows |
| Persistence | `reports/sarsEfilingRepo.ts` (260); migrations `231_sars_efiling.sql`, `504_sars_efiling_audit.sql` (`sars_efiling_events` + `efiling_*` columns on `sars_submissions`), `517` (RLS), `518` (append-only for `app_user`) | audit log holds no secrets |
| Tests | `tests/unit/sars/efiling-{client.contract,config,integration,submission,submission-poll,submission-send}.test.ts`, `tests/integration/k-031-efiling-vat201-source.int.test.ts` | run against an in-process mock ISV server, not SARS |
| UI | `src/components/accounting/sars/EfilingStatus.tsx` | shows Submit only when configured and exceptions are clean |

Known gaps recorded in the dossier that the spec must close [dossier 2a]: `generateVAT201` emits a
simplified `field1..field11` set and does not split 1A/2A/14A/15A or compute 16/17, whereas the real
return carries Fields 1-20; the Diesel refund field numbers are UNVERIFIED. The client passes the fields
map through verbatim today.

Tier-2 (per-taxpayer login name + login key, from each client's eFiling *Organisations > ISV Activation*
[dossier 1b]) has no storage at all. The env config above is a Tier-1 arming switch only [dossier 6].

## 3. What SARS must provide

1. **Authorisation** as an ISV for VAT201: signed ISV Systems Interface T&Cs, returned to the SARS ISV
   mailbox (likely `isv@sars.gov.za`, UNVERIFIED, confirm on the live SARS ISV page) [dossier 1a, 8].
2. **The VAT201 ISV interface spec**: protocol, schema, Fields 1-20 encoding, tax-period encoding, PIN
   (if any), status codes, error model [dossier 1c, 2b-2d].
3. **A test environment and Tier-1 vendor/test credentials** for acceptance testing [dossier 1d].
4. **Written approval** after acceptance testing, before any production activation (cl. 3.2, 3.4.5).
5. **"IsaFlow" in the eFiling ISV Activation dropdown**, so clients can generate their login name + key
   [dossier 0, 8 step 7].
6. Answers to the open questions: whether INF001 or an NDA is also required for VAT201; credential-storage
   security specifics (encryption, MFA) and any audit/retention clause (UNVERIFIED, released post-onboarding)
   [dossier 5, 7].

## 4. Unblock steps and owner

Owner: **Hein (commercial/legal; SARS contact is not delegable to an agent).** Engineering waits.

| # | Step | Owner | Done when |
|---|---|---|---|
| 1 | Read the ISV T&Cs v3 PDF; note volume targets (cl. 3.4.2: 1,000 / 5,000 / 10,000 submissions per tax type in years 1/2/3, withdrawal risk cl. 3.4.3), the acceptance-testing gate, and the staff Oath/Affirmation of Secrecy (cl. 8) | Hein | decision to proceed recorded |
| 2 | Confirm the current ISV mailbox and latest T&Cs on the live SARS ISV page | Hein | mailbox confirmed |
| 3 | Email SARS opening VAT201 ISV onboarding for IsaFlow (Pty) Ltd; ask for the spec, the acceptance-testing details and test environment, and whether INF001/NDA applies; attach company registration | Hein | SARS acknowledges |
| 4 | Sign and return the T&Cs (+ any NDA); staff who touch SARS taxpayer data sign the secrecy oath | Hein | SARS countersigns |
| 5 | Hand the released spec, test endpoint and Tier-1 test credentials to engineering (credentials into the 0600 secret store, never git, never chat) | Hein | spec file placed in `docs/sars/` |
| 6 | Acceptance testing and written approval (section 5, build) | engineering + Hein | written approval received |
| 7 | Dropdown listing live; pilot clients activate | SARS + Hein | first client key issued |

Dossier section 8 steps 2-4 are the same ask; this table adds the engineering hand-off.

**Done-signal for engineering to start:** the VAT201 spec and a SARS test endpoint (with test credentials)
exist as files in `docs/sars/` or the secret store. Until then W17 stays closed as "blocked".

## 5. What the build will be once unblocked

One build PR, plus a staged rollout, each behind the rules in section 6.

1. **Wire swap**, in `sarsEfilingClient.ts` only (the provisional format is confined there by design,
   header `:9-18`): real auth handshake, submit and poll per the spec (SOAP/XML if that is what SARS
   issues), real status-code mapping replacing the provisional `accepted|rejected|processing` set.
2. **Fields 1-20 mapping**: extend the VAT201 generator to produce 1A/2A/14A/15A and 16/17 and the Diesel
   section if applicable, with each mapping cited to the SARS guide (GEN-ELEC-04-G01). Reconcile against
   the existing `tests/fixtures/efiling/vat201-capture.*` fixtures.
3. **Tier-2 per-company credentials**: a new company-scoped table (`ENABLE` + `FORCE` RLS,
   `tenant_isolation`, `IF NOT EXISTS`, expand-only) holding the client's login name and key encrypted at
   rest; write path with VAT/Tax Approve; the key is never logged, returned, or placed in
   `sars_efiling_events`; revoke/rotate; encryption design agreed with the SARS security clauses once
   released. Needs a design round and a blind adversarial review (live client credentials).
4. **Per-company default-off flag** gating the Submit surface, in addition to the existing env arming
   (Tier-1) and the exceptions gate. Off for every company until that company has activated IsaFlow in its
   own eFiling profile and Hein enables it.
5. **Activation UX**: instructions for clients (eFiling > Organisations > ISV Activation > IsaFlow > copy
   login name + key) and a credential entry form with an `@example.invalid`-style test mode in dev.
6. **Acceptance tests against SARS's test endpoint** only (never production), recorded as evidence for the
   SARS approval. The contract tests move from the mock server to recorded SARS-test fixtures.
7. **Rollout**: SARS written approval -> prod env arming -> pilot companies -> general. VAT payment stays
   out of scope (done on eFiling) [dossier 8 step 9]. Track the volume targets from day one [dossier 8
   step 11]. The submit action stays an always-human gate: a real return to SARS is an irreversible
   external action.

Estimate is withheld until the spec shows the protocol: the dossier itself cannot say SOAP vs REST.

## 6. Standing gates (apply to every future ISV PR)

- No agent submits to SARS production, ever; test-endpoint traffic only after the spec and test
  credentials exist, and only from a disposable clone or the sandbox company, never Demo or a client.
- No SARS credential is committed, logged, pasted in chat, or stored plaintext.
- The server-side exceptions gate stays authoritative; the UI is a convenience.
- Production arming (`SARS_EFILING_*` on prod) is Hein's confirmation gate, as is each pilot company.
- Outbound/irreversible rule: a filed VAT201 cannot be recalled by us.

## 7. Open items

- ISV mailbox, INF001/NDA need, test-environment details, credential-storage clauses, wire format: all
  UNVERIFIED until SARS answers (dossier 7).
- Dossier section 0/6 still describe P4.2 as "pending PR #214"; it is on master. Not edited here (dossier
  is a dated record). The "~29 approved ISVs" figure is single-source.
- Spec §8 question Q10 (confirm blocker-only): this PR assumes the recommended answer; no other §8
  question is hit.
