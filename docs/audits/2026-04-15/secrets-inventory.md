# Secrets Inventory — 2026-04-15

**Source:** grep of `process.env.*` across `src/` `pages/` `scripts/` (run 2026-04-15)

## Classification legend
- **auth-critical** — rotation invalidates active user sessions; requires maintenance window.
- **data** — rotation requires connection draining; transient errors during cutover.
- **third-party** — rotation must coordinate with vendor; silent integration break if mistimed.
- **infra** — stateless; low risk; rotate any time.

---

## auth-critical
| Var | Used in | Notes |
|---|---|---|
| `JWT_SECRET` | `src/lib/auth/jwt.ts`, `middleware.ts` | Signs and verifies all user session tokens. Rotation logs every active user out immediately. Requires maintenance window or dual-secret strategy (accept old + new for one TTL cycle). |
| `ENCRYPTION_KEY` | `src/lib/encryption.ts` | Used to encrypt/decrypt sensitive persisted data (e.g. OAuth tokens). Rotation requires re-encrypting all stored ciphertext before the old key is removed; data is unreadable until migrated. |

---

## data
| Var | Used in | Notes |
|---|---|---|
| `DATABASE_URL` | `src/lib/neon.ts`, `scripts/run-migration.ts` | Primary Neon/Postgres connection string used by every API handler. Rotation requires draining in-flight queries; expect transient 5xx for the cutover window. Update and restart app atomically. |
| `REDIS_URL` | `src/lib/redis.ts`, `src/modules/admin/services/analyticsService.ts` | Used for rate-limiting and session caching. Loss of connection causes rate-limiter fallback behaviour; rotate with a brief maintenance window or use Redis replica promotion. |

---

## third-party
| Var | Used in | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `pages/api/accounting/ai-categorize.ts`, `src/modules/accounting/services/reports/cashFlowForecastAiService.ts` | Anthropic Claude API. Rotation requires generating a new key in the Anthropic console before removing the old one; in-flight AI requests will fail at cutover. |
| `GEMINI_API_KEY` | `scripts/generate-brand-identity.ts`, `scripts/generate-logo-v3.ts` | Google Gemini API. Used in offline scripts only (logo/brand generation). Low session-impact; rotate at will but coordinate with Google AI Studio. |
| `VLLM_API_KEY` | `src/modules/accounting/services/bank/vlmCore.ts` | Self-hosted or third-party vLLM endpoint auth. Coordinate rotation with the vLLM host operator. |
| `RESEND_API_KEY` | `src/modules/accounting/services/core/emailService.ts`, `src/modules/admin/services/analyticsService.ts` | Resend transactional email provider. Rotation must be coordinated with Resend dashboard; in-flight email sends will fail at cutover. |
| `SMTP_HOST` | `src/modules/accounting/services/core/emailService.ts` | SMTP server hostname. Changing implies a full SMTP provider switch; coordinate with mail provider. |
| `SMTP_PORT` | `src/modules/accounting/services/core/emailService.ts` | SMTP port (typically 465/587). Companion to `SMTP_HOST`. |
| `SMTP_USER` | `src/modules/accounting/services/core/emailService.ts` | SMTP account username / sender identity. |
| `SMTP_PASS` | `src/modules/accounting/services/core/emailService.ts` | SMTP account password. Rotation at mail provider + update together with `SMTP_USER`. |
| `SMTP_FROM` | `src/modules/accounting/services/core/emailService.ts` | Sender address used in outbound emails. Changing requires SPF/DKIM alignment with new address. |
| `STITCH_CLIENT_ID` | `src/modules/accounting/services/bank/bankFeedOAuthService.ts`, `src/lib/observability/deepChecks.ts` | Stitch (open-banking) OAuth client ID. Rotation must be coordinated with Stitch; existing bank-feed OAuth sessions will break until users re-authorise. |
| `STITCH_CLIENT_SECRET` | `src/modules/accounting/services/bank/bankFeedOAuthService.ts`, `src/modules/accounting/services/bank/bankFeedConnectionService.ts` | Stitch OAuth client secret. Rotate together with `STITCH_CLIENT_ID`; all active bank-feed connections must be re-authorised by users. |
| `STITCH_API_URL` | `src/lib/observability/deepChecks.ts`, `src/modules/accounting/services/bank/bankFeedConnectionService.ts` | Base URL of the Stitch GraphQL API. Should only change if Stitch migrates endpoints; treat as third-party config. |
| `STITCH_HEALTH_URL` | `src/lib/observability/deepChecks.ts` | Stitch health-check endpoint used by deep-checks observability. Stateless but vendor-controlled. |
| `STITCH_REDIRECT_URI` | `src/modules/accounting/services/bank/bankFeedOAuthService.ts` | OAuth redirect URI registered with Stitch. Must match the registered value exactly; changing requires updating the Stitch developer portal first. |
| `PAYFAST_MERCHANT_ID` | `src/modules/accounting/services/core/paymentGatewayCore.ts` | PayFast merchant identifier. Rotation requires new merchant account or key rotation in PayFast dashboard. |
| `PAYFAST_MERCHANT_KEY` | `src/modules/accounting/services/core/paymentGatewayCore.ts` | PayFast merchant key used to sign payment requests. Silent payment failures if mismatched. |
| `PAYFAST_PASSPHRASE` | `src/modules/accounting/services/core/paymentGatewayCore.ts` | PayFast signature passphrase. Coordinate rotation with PayFast; in-flight payment notifications will fail signature verification. |
| `PAYFAST_SANDBOX` | `src/modules/accounting/services/core/paymentGatewayCore.ts` | Boolean flag toggling PayFast sandbox mode. Infra-adjacent, but mis-setting this routes live payments to sandbox — classified third-party to enforce review before changing. |
| `VF_STORAGE_URL` | `src/services/vfStorageAdapter.ts` | Base URL for VelocityFibre file storage service. Changing requires coordinating with the VF storage team; stored file URLs may break. |
| `ADMIN_ALERT_WEBHOOK_URL` | `src/modules/admin/services/healthAlertService.ts` | Webhook URL (e.g. Slack/Teams) for health alert notifications. Rotation requires updating the webhook at the receiving platform first. |

---

## infra
| Var | Used in | Notes |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `next.config.js`, `pages/_app.tsx`, `middleware.ts` | Build-time public base URL of the app. Low risk; rotate (redeploy) whenever domain changes. |
| `NEXT_PUBLIC_ADMIN_URL` | `src/components/admin/ImpersonationBanner.tsx`, `pages/admin/companies/[id].tsx` | Build-time public URL for the admin portal. Low risk; redeploy to update. |
| `NODE_ENV` | `src/lib/neon.ts`, `src/lib/logger.ts`, `src/lib/api-error-handler.ts` | Standard Node environment flag (`production`/`development`/`test`). Set by runtime/platform, not a secret. |
| `NEON_USE_HTTP` | `src/lib/neon.ts` | Feature flag to use Neon HTTP driver instead of WebSocket. Stateless toggle; rotate any time. |
| `SLOW_QUERY_MS_THRESHOLD` | `src/lib/neon.ts` | Threshold (ms) for slow-query logging. Operational tuning knob; no rotation risk. |
| `HEALTH_CHECK_TIMEOUT_MS` | `src/lib/observability/deepChecks.ts` | Timeout for deep-health-check probes. Operational tuning knob; no rotation risk. |
| `ADMIN_ALERT_EMAIL` | `src/modules/admin/services/healthAlertService.ts` | Destination email address for health alerts. Changing redirects alert emails; low risk. |
| `VLLM_BASE_URL` | `src/modules/accounting/services/bank/vlmCore.ts` | Base URL of the vLLM inference server. Infra endpoint; low risk to update with a redeploy. |
| `VLLM_MODEL` | `src/modules/accounting/services/bank/vlmCore.ts` | Model identifier string for the vLLM endpoint. Changing affects AI output quality but carries no secret rotation risk. |
| `VLLM_TIMEOUT` | `src/modules/accounting/services/bank/vlmCore.ts` | HTTP timeout (ms) for vLLM inference calls. Operational tuning knob. |
| `VLM_MODEL` | `pages/api/onboarding/extract.ts`, `pages/api/onboarding/extract-id.ts` | Model identifier for onboarding document extraction. Similar to `VLLM_MODEL`; no secret. Review later — possible duplicate/alias of `VLLM_MODEL`. |
| `PENTEST_BASE_URL` | `scripts/pentest-admin.ts` | Base URL used by the pentest script to target an environment. Scripts-only; never deployed to production runtime. |
| `KNOWN_COMPANY_ID` | `scripts/pentest-admin.ts` | Hard-coded test company UUID used by pentest/QA scripts. Scripts-only; no runtime exposure. |
| `KNOWN_USER_ID` | `scripts/pentest-admin.ts` | Hard-coded test user UUID used by pentest/QA scripts. Scripts-only; no runtime exposure. |
| `ADMIN_JWT` | `scripts/pentest-admin.ts` | Pre-minted admin JWT for pentest scripts. Scripts-only; not a production secret but should be short-lived and regenerated per pentest run. |
| `REGULAR_JWT` | `scripts/pentest-admin.ts` | Pre-minted regular-user JWT for pentest scripts. Scripts-only; same guidance as `ADMIN_JWT`. |

---

## Coverage check
Grep returned **41** unique env vars. Inventory classifies **41**. Delta: **0**.

### Uncertain classifications (resolved)
| Var | Chosen bucket | Rationale |
|---|---|---|
| `PAYFAST_SANDBOX` | third-party | Boolean flag but mis-setting it routes live payments to sandbox — review required before changing, same care as other PayFast vars. |
| `ADMIN_JWT` / `REGULAR_JWT` | infra | Pentest-script fixtures only; never read by production runtime. Short-lived by convention; no session rotation risk in production. |
| `ADMIN_ALERT_EMAIL` | infra | Plain email address string; no signing/crypto role. |
| `VLM_MODEL` | infra | Possible alias/duplicate of `VLLM_MODEL`; no secret value, review later for cleanup. |
