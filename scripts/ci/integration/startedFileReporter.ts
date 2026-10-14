/**
 * A vitest reporter that appends each test file's path to
 * $INTEGRATION_STARTED_LOG as vitest starts it. The integration gate runs one
 * file at a time (--no-file-parallelism), so when a shard hits its time limit
 * the log's last line names the file that was running (shard.sh prints it).
 * vitest's own reporter names a file only once it has finished.
 */
import { appendFileSync } from 'node:fs';
import type { Reporter, TestModule } from 'vitest/node';

export default class StartedFileReporter implements Reporter {
  onTestModuleStart(testModule: TestModule): void {
    const out = process.env.INTEGRATION_STARTED_LOG;
    if (out) appendFileSync(out, `${testModule.moduleId}\n`);
  }
}
