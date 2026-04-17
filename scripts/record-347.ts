import { neon } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
const envPath = path.resolve(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath,'utf-8').split('\n')) { const m=line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if(m&&!process.env[m[1]!])process.env[m[1]!]=m[2]!.replace(/^["']|["']$/g,''); }
(async () => {
  const sql = neon(process.env.DATABASE_URL!);
  const content = fs.readFileSync(path.resolve(__dirname, 'migrations/sql/347_auto_posting_foundation.sql'), 'utf-8');
  const checksum = createHash('sha256').update(content).digest('hex');
  await sql`INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ('347', '347_auto_posting_foundation', ${checksum}, NOW()) ON CONFLICT (name) DO NOTHING`;
  const r = await sql`SELECT version, name FROM schema_migrations WHERE version='347'` as any[];
  console.log('Recorded:', r);
})().catch(e=>console.error(e.message));
