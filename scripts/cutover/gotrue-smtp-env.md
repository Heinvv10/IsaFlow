# GoTrue SMTP env (to be set on velo at /home/velo/supabase/.env)

Append the following to `/home/velo/supabase/.env`, then restart the auth container:

```bash
docker compose -f /home/velo/supabase/docker-compose.yml up -d supabase-auth
```

## Env block

The app uses `mail.isaflow.co.za` (port 465, TLS) with `noreply@isaflow.co.za`.
GoTrue uses port 587 (STARTTLS) by default; if the isaflow.co.za mail server only
supports 465 (implicit TLS), set `GOTRUE_SMTP_PORT=465` and verify the GoTrue
version supports implicit TLS (Supabase ≥ v1.24 does via `GOTRUE_SMTP_ADMIN_EMAIL`
env). Adjust port accordingly.

```bash
GOTRUE_SMTP_HOST=mail.isaflow.co.za
GOTRUE_SMTP_PORT=587
GOTRUE_SMTP_USER=noreply@isaflow.co.za
GOTRUE_SMTP_PASS=<see SMTP_PASS in /home/velo/supabase/.env or ops secrets>
GOTRUE_SMTP_ADMIN_EMAIL=noreply@isaflow.co.za
GOTRUE_SMTP_SENDER_NAME=IsaFlow
GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/reset-password
GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/confirm
GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=/auth/confirm-email-change
GOTRUE_MAILER_AUTOCONFIRM=false
GOTRUE_SITE_URL=https://app.isaflow.co.za
GOTRUE_URI_ALLOW_LIST=https://app.isaflow.co.za,https://dev.isaflow.co.za
```

## Apply steps (Hein's manual step — do NOT run from CI)

```bash
ssh velo@100.96.203.105
# Append the block above to /home/velo/supabase/.env
nano /home/velo/supabase/.env
# Restart auth container
cd /home/velo/supabase
docker compose up -d supabase-auth
docker logs supabase-auth --tail 30
# Expected: "mailer configured" log line, no SMTP errors
```

## Verification

```bash
# From velo or any machine with access to port 8300:
curl -X POST http://100.96.203.105:8300/auth/v1/recover \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "content-type: application/json" \
  -d '{"email": "test@isaflow.co.za"}'
# Should return 200 and deliver a reset email via noreply@isaflow.co.za
```
