# ISAFlow OAuth 2.0 — Integration Developer Guide

This guide takes you from zero to a working ISAFlow OAuth integration in under 10 minutes. The flow is **standard OAuth 2.0 authorization-code with PKCE** — same pattern as Xero, QuickBooks Online, and most modern SaaS APIs. No surprises.

## What this is for

Use OAuth when you're building an app that other ISAFlow users will install — e.g. a receipt-capture vendor, an analytics tool, an AI assistant. Your app gets an access token scoped to a specific user's data, valid for ~1 hour, refreshable for 30 days.

If you're writing a script that runs as **yourself** (cron, CI, automation), use a [Personal Access Token](./personal-access-tokens.md) instead — much simpler.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET https://app.isaflow.co.za/oauth/authorize` | Consent screen — redirect users here |
| `POST https://app.isaflow.co.za/api/oauth/token` | Exchange auth code → access+refresh tokens; rotate refresh |

## Step 1 — Register your app

Go to **Settings → Developer → OAuth Apps** in ISAFlow. Click "Register app" and provide:

- **Name** — what users will see on the consent screen.
- **Redirect URI(s)** — must be HTTPS in production (HTTP localhost is allowed for dev).
- Optional: logo URL, homepage, description.

You'll receive:

- `client_id` — public, e.g. `client_jK7n8pQ4mT9XyZv2bWcD3eFf`
- `client_secret` — **shown once**. Treat as a credential — never commit to source.

## Step 2 — Send the user to ISAFlow's consent screen

```
https://app.isaflow.co.za/oauth/authorize
  ?response_type=code
  &client_id=client_jK7n8pQ4mT9XyZv2bWcD3eFf
  &redirect_uri=https://your-app.com/oauth/callback
  &scope=read:invoices+write:invoices+offline_access
  &state=<random>
  &code_challenge=<sha256-base64url(verifier)>
  &code_challenge_method=S256
```

**PKCE is mandatory.** Generate a random `code_verifier` (43–128 chars from `[A-Za-z0-9-._~]`), then derive `code_challenge = base64url(sha256(code_verifier))`. Keep `code_verifier` server-side; you'll need it at step 4.

The user authorises (or cancels). On success, ISAFlow redirects:

```
https://your-app.com/oauth/callback?code=oac_AbCd...&state=<your-state>
```

On cancel, `?error=access_denied&state=...`.

## Step 3 — Verify the `state` matches

Compare the returned `state` to the value you sent. If different, abort — this is a CSRF attempt.

## Step 4 — Exchange the code for tokens

```
POST https://app.isaflow.co.za/api/oauth/token
Content-Type: application/json

{
  "grant_type": "authorization_code",
  "client_id": "client_jK7n8pQ4mT9XyZv2bWcD3eFf",
  "client_secret": "cls_...",
  "code": "oac_AbCd...",
  "redirect_uri": "https://your-app.com/oauth/callback",
  "code_verifier": "<the verifier from step 2>"
}
```

Response (200):

```json
{
  "access_token": "oat_...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "ort_...",
  "scope": "read:invoices write:invoices offline_access"
}
```

`refresh_token` is only included if you requested `offline_access`.

## Step 5 — Call the API

```
GET https://app.isaflow.co.za/api/accounting/customer-invoices
Authorization: Bearer oat_...
```

Tokens are scoped to the company the user selected on the consent screen. ISAFlow's RLS handles tenant isolation; your token cannot reach data from any other company even if you craft requests.

## Step 6 — Refresh when the access token expires

```
POST https://app.isaflow.co.za/api/oauth/token
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "ort_..."
}
```

Refresh tokens are **single-use**. The response includes a fresh `refresh_token` that replaces the old one. Replaying an old refresh token returns `invalid_grant`.

## Scopes

| Scope | Grants |
|---|---|
| `read:reports` | Trial balance, income statement, balance sheet, etc. |
| `read:invoices` | List and view customer/supplier invoices |
| `write:invoices` | Create, edit, post invoices |
| `read:bank-tx` | View imported bank statements and allocations |
| `write:bank-tx` | Allocate, edit, post bank transactions |
| `write:journals` | Post General Ledger journal entries |
| `offline_access` | **Required for refresh tokens.** Without this, `refresh_token` is omitted from the token response. |

Request only the scopes you need — users can see exactly what you're asking for and may decline.

## Errors

The token endpoint follows RFC 6749 error format:

```json
{ "error": "invalid_grant", "error_description": "..." }
```

| Code | Meaning |
|---|---|
| `invalid_request` | Required parameter missing |
| `invalid_client` | `client_id` unknown or `client_secret` wrong |
| `invalid_grant` | Code/refresh expired, used, or replayed; PKCE mismatch |
| `unsupported_grant_type` | Only `authorization_code` and `refresh_token` are supported |

API endpoints (post-auth) return JSON in the project's standard shape:

```json
{ "success": false, "error": { "code": "INSUFFICIENT_SCOPE", "message": "Token missing required scope: write:invoices" } }
```

## Sample clients

### Python (with [authlib](https://docs.authlib.org/))

```python
import secrets, hashlib, base64, requests
from urllib.parse import urlencode

CLIENT_ID = "..."
CLIENT_SECRET = "..."
REDIRECT_URI = "https://your-app.com/oauth/callback"

# Step 2 — build authorise URL
verifier = secrets.token_urlsafe(64)
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
state = secrets.token_urlsafe(16)
url = "https://app.isaflow.co.za/oauth/authorize?" + urlencode({
    "response_type": "code",
    "client_id": CLIENT_ID,
    "redirect_uri": REDIRECT_URI,
    "scope": "read:invoices offline_access",
    "state": state,
    "code_challenge": challenge,
    "code_challenge_method": "S256",
})
print(f"Visit: {url}")  # in production, redirect the user

# Step 4 — exchange (after the user is redirected back with ?code=...&state=...)
code = input("Paste code: ")
r = requests.post("https://app.isaflow.co.za/api/oauth/token", json={
    "grant_type": "authorization_code",
    "client_id": CLIENT_ID,
    "client_secret": CLIENT_SECRET,
    "code": code,
    "redirect_uri": REDIRECT_URI,
    "code_verifier": verifier,
})
tokens = r.json()
print(tokens["access_token"])
```

### Node.js

```javascript
import crypto from 'crypto';

const verifier = crypto.randomBytes(64).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('base64url');

const url = `https://app.isaflow.co.za/oauth/authorize?` + new URLSearchParams({
  response_type: 'code',
  client_id: process.env.ISAFLOW_CLIENT_ID,
  redirect_uri: 'https://your-app.com/oauth/callback',
  scope: 'read:invoices offline_access',
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
});
// Redirect the user to `url`. On callback:

const tokens = await fetch('https://app.isaflow.co.za/api/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    grant_type: 'authorization_code',
    client_id: process.env.ISAFLOW_CLIENT_ID,
    client_secret: process.env.ISAFLOW_CLIENT_SECRET,
    code: req.query.code,
    redirect_uri: 'https://your-app.com/oauth/callback',
    code_verifier: verifier, // retrieved from session
  }),
}).then((r) => r.json());
```

## Security expectations

- **Client secrets must never reach the browser.** Confidential clients (anything that runs on a server) MUST hold the secret server-side. Public clients (mobile, SPA) should use PKCE-only with no client secret.
- **`redirect_uri` must exactly match** one of the URIs registered for your app. Mismatch returns `400 invalid_request`.
- **Refresh tokens are single-use.** Store the latest one; discard the previous one on each refresh.
- **Revoke immediately** when an integration is no longer needed — call `DELETE /api/oauth/authorisations/:id` from the user's UI, or revoke the entire app from the Developer page (cascades to all authorisations).

## Debugging

ISAFlow tags every API call with the auth method (`auth.method = oauth`) and the authorisation id. If you see unexpected 401s or 403s, ask Velocity Fibre support for the request id from the response headers — they can trace the call and tell you which scope check failed.

## Where to manage

| Page | Purpose |
|---|---|
| `/developer/oauth-apps` | Register & revoke your apps; view client_id and (once) client_secret |
| `/accounting/settings/connected-apps` | The user-facing list of apps they've authorised; revoke per-app |
