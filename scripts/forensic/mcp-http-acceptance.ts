/** Run only against an explicitly selected local server and disposable fixture database. */
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runMcpHttpAcceptance} from '../../tests/integration/mcp-http/fixtures';
const output=process.argv[2];
if(!output)throw new Error('Usage: bun scripts/forensic/mcp-http-acceptance.ts <redacted-evidence.json>');
const result=await runMcpHttpAcceptance(process.env);
await writeFile(resolve(output),`${JSON.stringify(result,null,2)}\n`,{mode:0o600});
