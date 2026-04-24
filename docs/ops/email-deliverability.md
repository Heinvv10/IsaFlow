# Email Deliverability — DKIM, DMARC, SPF

**Domain:** `isaflow.co.za`
**Mail host:** `mail.isaflow.co.za` (196.22.132.132, host-h.net)
**App sender:** `noreply@isaflow.co.za` (Supabase GoTrue) · `accounts@isaflow.co.za` (SMTP_FROM default)

## Why this matters

Since Gmail & Yahoo's Feb 2024 bulk-sender requirements, and Outlook's
follow-on May 2025 enforcement, transactional email now needs **all three** of
SPF, DKIM, and DMARC aligned to the sending domain. Missing DMARC alone is
enough for mail to land in spam even when SPF passes.

## Current state (snapshot)

Run this to confirm:

```bash
dig +short TXT isaflow.co.za | grep -i spf
dig +short TXT _dmarc.isaflow.co.za
for sel in default mail smtp cpanel k1 selector1 selector2; do
  out=$(dig +short TXT "${sel}._domainkey.isaflow.co.za")
  [ -n "$out" ] && echo "[$sel] $out"
done
```

Initial state (captured 2026-04-24):

| Record | Value | Verdict |
|---|---|---|
| SPF  | `v=spf1 mx a include:spf.host-h.net ?all` | **Broken** — `?all` is "neutral", effectively no enforcement. Must be `~all` (softfail) or `-all` (hardfail). |
| DMARC | *(missing)* | **Critical** — root cause of spam-folder drops at Gmail/Outlook. |
| DKIM  | *(no selector resolves)* | **Critical** — outbound mail is unsigned. |

## Applied state (2026-04-24 via Cloudflare API)

DNS is hosted on Cloudflare (zone `584265adbf74478796c252230421dc8e`,
nameservers `danica.ns.cloudflare.com` / `nico.ns.cloudflare.com`).
Steps 1 and 2 below were applied directly via the CF API on 2026-04-24:

| Record | Value | Applied |
|---|---|---|
| SPF (`isaflow.co.za`) | `v=spf1 mx a include:spf.host-h.net ~all` | ✅ 2026-04-24 |
| DMARC (`_dmarc.isaflow.co.za`) | `v=DMARC1; p=none; fo=1; adkim=r; aspf=r` | ✅ 2026-04-24 |
| DKIM | *(still needs host-h ticket — see Step 3)* | ⏳ blocked on host-h |

DMARC was published **without** `rua=` / `ruf=` so reports aren't mailed to
an address that would bounce. Add `rua=mailto:dmarc@isaflow.co.za` once that
mailbox (or alias) is created at host-h.

## Fix plan — in order

### Step 1 — DMARC record (APPLIED 2026-04-24)

The following TXT record is now published on `isaflow.co.za` via Cloudflare:

| Name | Type | Value | TTL |
|---|---|---|---|
| `_dmarc.isaflow.co.za` | TXT | `v=DMARC1; p=none; fo=1; adkim=r; aspf=r` | 3600 |

- `p=none` means "monitor only, don't reject" — safe first step.
- `adkim=r` / `aspf=r` = relaxed alignment (matches subdomains too).
- **Follow-on:** create `dmarc@isaflow.co.za` (mailbox or alias), then PATCH
  the record to append `rua=mailto:dmarc@isaflow.co.za; ruf=mailto:dmarc@isaflow.co.za`
  so aggregate/failure reports start flowing in.

Verify after DNS propagation:

```bash
dig +short TXT _dmarc.isaflow.co.za
# Expect: "v=DMARC1; p=none; ..."
```

### Step 2 — Fix SPF `?all` → `~all` (APPLIED 2026-04-24)

The SPF record on `isaflow.co.za` has been updated via Cloudflare:

| Before | After |
|---|---|
| `v=spf1 mx a include:spf.host-h.net ?all` | `v=spf1 mx a include:spf.host-h.net ~all` |

Verify:

```bash
dig +short TXT isaflow.co.za | grep -i spf
# Expect: "v=spf1 mx a include:spf.host-h.net ~all"
```

### Step 3 — DKIM (requires host-h support)

host-h.net manages the mail server, so they control DKIM signing and the
selector. Open a support ticket with this template:

> Subject: Enable DKIM signing for isaflow.co.za
>
> Hi,
>
> Please enable DKIM signing for outbound mail sent from `mail.isaflow.co.za`
> on behalf of `isaflow.co.za`. Can you:
>
> 1. Generate a 2048-bit DKIM keypair for the domain.
> 2. Sign outbound mail with the new selector.
> 3. Send me the TXT record I need to publish at
>    `<selector>._domainkey.isaflow.co.za`.
>
> Our DMARC record is already in monitor mode (`p=none`), so DKIM failures
> will not reject mail during the rollout.
>
> Thanks.

Once they reply with the selector name and the public-key TXT value, publish
it at the registrar:

| Name | Type | Value | TTL |
|---|---|---|---|
| `<selector>._domainkey.isaflow.co.za` | TXT | `v=DKIM1; k=rsa; p=MIIBIjAN...` (from host-h) | 3600 |

Verify signing end-to-end:

```bash
# Send a test to the check-auth alias at Google
echo "test" | mail -s "dkim test" check-auth@verifier.port25.com
# Or use https://www.mail-tester.com/ — paste the test address, then send
# from ISAFlow (e.g. the invite flow) and refresh the report.
```

Success criteria: `DKIM: pass`, `SPF: pass`, `DMARC: pass` with both
`aligned (d=isaflow.co.za)`.

### Step 4 — DMARC tightening (after 2 weeks of clean `rua` reports)

Once aggregate reports show 100 % aligned pass for legitimate senders, ratchet
the policy:

| Phase | Policy | When |
|---|---|---|
| 1 — Monitor | `p=none` | Week 0 (now) |
| 2 — Quarantine | `p=quarantine; pct=25` | Week 2, if reports clean |
| 3 — Quarantine full | `p=quarantine; pct=100` | Week 3 |
| 4 — Reject | `p=reject; pct=100` | Week 5 |

Never skip phase 2. Let aggregate reports (`dmarc@isaflow.co.za`) flush for
~7 days between promotions so any forgotten third-party sender surfaces
before it gets bounced.

## Third-party senders to inventory

Anything that sends `From: *@isaflow.co.za` must be listed in SPF **or** sign
with DKIM aligned to the domain. Check before promoting DMARC past `p=none`:

- [ ] Supabase GoTrue (via `mail.isaflow.co.za`) — covered by SPF `mx a` + DKIM
- [ ] App SMTP sender (`accounts@isaflow.co.za` via `mail.isaflow.co.za`) — same
- [ ] Postmark/Resend/other ESP (none currently configured, but check)
- [ ] Any marketing / newsletter platform
- [ ] CI/monitoring that emails alerts (e.g. Bugsink, Grafana)

If a third-party is found: either add its include to SPF
(`include:amazonses.com`, `include:spf.mailjet.com`, etc.) or configure DKIM
delegation at that vendor.

## Ongoing monitoring

- Weekly: `dig +short TXT _dmarc.isaflow.co.za` — confirm the record survives
  DNS edits.
- Weekly: scan `dmarc@isaflow.co.za` aggregate reports for failures before
  each policy promotion.
- Per release: send a test to `https://www.mail-tester.com/` — should score
  ≥ 9/10 with no SPF/DKIM/DMARC findings.
