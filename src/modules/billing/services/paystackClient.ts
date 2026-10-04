/**
 * Paystack REST client.
 *
 * Auth: Bearer token using PAYSTACK_SECRET_KEY (sk_test_/sk_live_).
 * Currency: ZAR. Amounts on the wire are in cents (smallest unit) — same
 * unit we already store in BIGINT cents columns.
 *
 * Endpoints used:
 *   POST /transaction/initialize          — start a hosted checkout
 *   GET  /transaction/verify/:reference   — verify final status
 *   POST /transaction/charge_authorization — recurring debit on an authorization
 *   POST /plan                            — create a plan (one per pricing tier)
 *   POST /subscription                    — start a subscription on an authorization
 *   POST /subscription/disable            — cancel a subscription
 *
 * Webhook signature verification lives in pages/api/webhooks/paystack.ts.
 */

export * from './paystackTransactions';
export * from './paystackSubscriptions';
