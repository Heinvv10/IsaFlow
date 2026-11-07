/**
 * Every writer of bank_transaction_attachments.file_name except the captured-document copy must pass the name through
 * uploadFileName. bank/bankLineDocumentSql recognises a captured document's copy by a "<uuid>_" name, so an upload
 * stored under such a name would pass for a linked document's copy and hide the document. The copy writer
 * (captureBankTxAttachService) is the one file allowed to store that shape.
 *
 * Mutation: drop uploadFileName from any of the writers below, or add a new writer without it, and this goes red.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const WRITE = /\bINSERT\s+INTO\s+(?:"?public"?\s*\.\s*)?"?bank_transaction_attachments\b/i;
const COPY_WRITER = 'src/modules/accounting/services/capture/captureBankTxAttachService.ts';

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function writers(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => WRITE.test(code(readFileSync(resolve(ROOT, f), 'utf8'))));
}

describe('bank attachment file-name writer census', () => {
  it('finds the four writers it knows, and no others', () => {
    expect(writers().sort()).toEqual([
      'pages/api/accounting/bank-tx-attachments.ts',
      'src/modules/accounting/services/bank/bankTxAttachmentService.ts',
      COPY_WRITER,
      'src/modules/accounting/services/capture/bankTxQueryReplyService.ts',
    ].sort());
  });

  it('every writer but the copy writer stores names through uploadFileName', () => {
    for (const f of writers().filter((w) => w !== COPY_WRITER)) {
      expect(code(readFileSync(resolve(ROOT, f), 'utf8')), f).toMatch(/\buploadFileName\(/);
    }
  });
});
