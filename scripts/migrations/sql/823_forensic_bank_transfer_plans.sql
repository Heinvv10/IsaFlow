-- Extend immutable bank-bound intents; existing RLS, grants and append-only rows remain authoritative.
ALTER TABLE control_bank_allocation_intents
 DROP CONSTRAINT IF EXISTS control_bank_allocation_intents_payload_check;
ALTER TABLE control_bank_allocation_intents ADD CONSTRAINT control_bank_allocation_intents_payload_check CHECK(COALESCE(
 jsonb_typeof(payload)='object' AND payload->>'version'='1'
 AND payload->>'kind' IN('account','split','customer','supplier','transfer')
 AND (payload->>'kind'<>'transfer' OR (
  payload->>'bankTransactionId'=bank_transaction_id::text
  AND jsonb_typeof(payload->'counterpartyAccountId')='string'
  AND payload->>'counterpartyAccountId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  AND jsonb_typeof(payload->'transfer')='object'
  AND ((payload->'transfer'->>'mode'='post'
   AND ((payload->'transfer') - 'mode' - 'oppositeBankTransactionId')='{}'::jsonb
   AND (payload->'transfer'->'oppositeBankTransactionId'='null'::jsonb OR (
    jsonb_typeof(payload->'transfer'->'oppositeBankTransactionId')='string'
    AND payload->'transfer'->>'oppositeBankTransactionId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    AND payload->'transfer'->>'oppositeBankTransactionId'<>bank_transaction_id::text)))
   OR (payload->'transfer'->>'mode'='link'
    AND ((payload->'transfer') - 'mode' - 'originalIntentId')='{}'::jsonb
    AND jsonb_typeof(payload->'transfer'->'originalIntentId')='string'
    AND payload->'transfer'->>'originalIntentId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'))
 )),false));
