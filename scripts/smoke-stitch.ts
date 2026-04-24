/**
 * Smoke-test the Stitch Express client end-to-end against the sandbox.
 * Usage: bun run scripts/smoke-stitch.ts
 */

import 'dotenv/config';
import { createPaymentLink, getPaymentStatus } from '../src/modules/billing/services/stitchClient';

async function main() {
  console.log('== creating payment link ==');
  const created = await createPaymentLink({
    amountCents: 12345,
    payerName: 'Smoke Test',
    merchantReference: `SMOKE-${Date.now()}`,
    externalReference: `smoke-${Date.now()}`,
    redirectUrl: 'http://localhost:3200/portal/payments/stitch/return',
    description: 'IsaFlow smoke test',
  });
  console.log(JSON.stringify(created, null, 2));

  console.log('\n== fetching status ==');
  const status = await getPaymentStatus(created.id);
  console.log(JSON.stringify(status, null, 2));

  console.log('\n✅ Client works. Checkout URL:', created.url);
}

main().catch((err) => {
  console.error('❌ smoke test failed:', err);
  process.exit(1);
});
