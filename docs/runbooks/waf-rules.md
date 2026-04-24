# WAF / Edge Rate-Limit Rules Runbook

**Pentest reference:** L19 — edge-level rate limiting.

## When to use this

- Standing up a new environment (prod / staging) behind Cloudflare.
- Responding to a credential-stuffing wave against `/api/auth/*`.
- Replacing the rules after a Cloudflare zone migration.

## Why it matters

All existing rate limits run in Node via `src/lib/rateLimit.ts`. Each attempted
request costs:

1. TLS handshake + HTTP parsing.
2. One `rate_limit_counters` row UPSERT (DB round-trip) per key-near-limit.
3. A pool connection held for the duration of the reply.

At 10 k RPS of credential-stuffing against `/api/auth/login`, this is enough to
starve the pool and degrade the legitimate login path. A WAF rule drops the
traffic before it touches Node.

The layered model we want:

| Layer         | Purpose                                  | Fires on                      |
|---------------|------------------------------------------|-------------------------------|
| Cloudflare    | Bulk abuse, volumetric floods, geo/IP    | Thousands of RPS from one IP  |
| nginx         | If CF is bypassed or misconfigured       | Per-zone request rate         |
| Node rate-lim | Per-user / per-company semantics (IP+key)| Credential brute force        |

Node's limiter stays in place; the WAF is an additional gate.

---

## Cloudflare rules to deploy

Apply these in **Security → WAF → Custom rules** on the `app.isaflow.co.za`
zone. Order matters — the first matching rule wins.

### Rule 1 — `/api/auth/*` volumetric cap

```
Expression: (http.request.uri.path matches "^/api/auth/.*")
Action:     Block
Rate limit: 60 requests per 60 seconds per source IP
```

**Rationale:** Node's per-email limit is 10 / 15 min. A CF cap of 60 req/min
per IP is ~6× the Node limit, so legitimate users never hit CF first; only
volumetric floods do. `/api/auth/login`, `/api/auth/2fa-challenge`,
`/api/auth/forgot-password`, `/api/auth/reset-password`, and
`/api/auth/change-password` are all covered.

### Rule 2 — `/api/webhooks/*` IP allowlist

```
Expression: (http.request.uri.path matches "^/api/webhooks/.*")
            and not (ip.src in $stitch_webhook_ips)
            and not (ip.src in $postmark_webhook_ips)
Action:     Block
```

**Source-of-truth IP ranges:**

- **Stitch:** `https://docs.stitch.money/docs/webhook-verification` — keep the
  `$stitch_webhook_ips` IP List in CF synced with their published CIDRs.
- **Postmark:** `https://postmarkapp.com/support/article/800-ips-for-firewalls`
  — same pattern, `$postmark_webhook_ips`.

Refresh both lists quarterly as part of the vendor review. Without this rule
any IP can POST to `/api/webhooks/stitch` and the handler's signature check is
the only protection.

### Rule 3 (optional) — `/api/admin/*` corporate-IP gate

```
Expression: (http.request.uri.path matches "^/api/admin/.*")
            and not (ip.src in $velocity_office_ips)
            and not (ip.src in $velocity_vpn_ips)
Action:     Managed Challenge
```

**Use Managed Challenge, not Block.** Admins occasionally log in from
conferences or home; a Block is a foot-gun if the VPN is misconfigured.
The Node layer enforces `platform_admin` role on top of whatever passes here.

Only deploy Rule 3 after confirming the VPN is used 100 % of the time for
admin work.

---

## nginx equivalents (fallback / dev)

Appended to `server { … }` in `nginx/conf.d/isaflow.conf`:

```nginx
limit_req_zone $binary_remote_addr zone=auth_zone:10m rate=60r/m;
limit_req_zone $binary_remote_addr zone=api_zone:10m  rate=300r/m;

location /api/auth/ {
  limit_req zone=auth_zone burst=10 nodelay;
  limit_req_status 429;
  proxy_pass http://127.0.0.1:3200;
}

location /api/ {
  limit_req zone=api_zone burst=50 nodelay;
  limit_req_status 429;
  proxy_pass http://127.0.0.1:3200;
}
```

`burst` + `nodelay` lets legitimate users spike briefly (retry logic, tab
switches) without a 429; the zone rate clamps sustained abuse. Test with
`nginx -t` before `systemctl reload nginx`.

---

## Verification

After deploying CF rules, run these from a single source IP **not** in the
allowlists. Cap the test at 200 requests — enough to confirm the rule, not
enough to trigger CF's account-level abuse controls.

```bash
# Rule 1 — should see 429 from CF (not Node) after ~60 req
for i in $(seq 1 100); do
  curl -s -o /dev/null -w "%{http_code} " https://app.isaflow.co.za/api/auth/login
done
echo
```

Confirm the 429 response has `Server: cloudflare` in the headers; a
`X-Powered-By: Next.js` response means the request reached Node and the rule
is misconfigured.

```bash
# Rule 2 — should see 403 from CF when sending from an IP outside the list
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST https://app.isaflow.co.za/api/webhooks/stitch \
  -H 'Content-Type: application/json' -d '{}'
```

Expect `403`, not `400`/`401`. A `400` means you reached Node.

```bash
# Rule 3 — should see Cloudflare's challenge page HTML
curl -s https://app.isaflow.co.za/api/admin/companies | grep -i cloudflare
```

---

## Rollback

Each rule has a toggle in the CF dashboard (`Enabled / Disabled`). Disable
first, observe, delete only after 24 h with no false-positive reports. IP
Lists (`$stitch_webhook_ips` etc.) should be preserved through rollback so the
rule can be re-enabled quickly.

No Node code depends on these rules, so rolling back never breaks the app —
worst case the Node rate limiter handles the load alone (as it does today).

---

## Maintenance

- **Quarterly:** resync Stitch and Postmark IP lists against vendor docs.
- **On vendor change:** update the IP List the day the change is announced.
- **After any `/api/auth/*` route added:** verify the new path matches Rule 1's
  regex (`^/api/auth/.*` covers every subpath, including nested ones).

## References

- Pentest report L19 — `docs/security/pentest-report-2026-04.md`
- Rate limiter internals — `src/lib/rateLimit.ts` and `src/lib/rateLimit.claude.md`
- `getClientIp()` rationale — see BL-20 / inline comment on the function.
