import 'dotenv/config';
import { signExtensionToken } from '../src/lib/auth/extensionJwt.ts';
const jwt = await signExtensionToken({
  userId: 'a0000000-0000-0000-0000-000000000001',
  companyId: '00000000-0000-0000-0000-0000000d4e02',
  connectionId: '28538dbd-2532-4618-a5fc-aaaca415a829',
  bankId: 'absa',
  scope: 'bank-feed-ingest',
});
process.stdout.write(jwt + '\n');
