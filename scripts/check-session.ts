import { sql } from '../src/lib/neon.ts';
// Test exact same query the middleware uses
const result = await sql`
  SELECT u.id, u.role, u.is_active, s.id as session_id, s.expires_at
  FROM users u
  INNER JOIN user_sessions s ON s.user_id = u.id
  WHERE u.id = ${'f110ef4f-e388-442e-8428-1a265b8d0a6a'}
    AND s.id = ${'669'}
    AND s.token_hash = ${'58d9bffc17cf4fb84331ea689a9ed5219bf0360cabef49f9ee5fe1a2f4ea1ec8'}
    AND s.expires_at > NOW()
    AND u.is_active = true
  LIMIT 1
`;
process.stderr.write('RESULT: ' + JSON.stringify(result) + '\n');
