/**
 * A PIECE OF THE PACK'S PROSE, WITH EACH RUN OF A DICTIONARY-BROKEN SCRIPT SET TO BREAK ANYWHERE (#1263 round 2): Thai,
 * Lao, Myanmar, Khmer and the Tai scripts in a `.pack-dictionary` span (`word-break: break-all`), the rest as it is.
 * Every prose text the page model measures with `proseLines` is rendered through it, so Chromium breaks those runs where
 * the model does (`packDictionaryBreak.ts`).
 */
import { Fragment, type ReactNode } from 'react';
import { dictionaryRuns } from '@/modules/accounting/services/packs/pages/packDictionaryBreak';

export function proseText(text: string | null | undefined): ReactNode {
  if (typeof text !== 'string') return text;
  const runs = dictionaryRuns(text);
  if (runs.length === 1 && !runs[0]!.dictionary) return text;
  return runs.map((run, i) => (run.dictionary
    ? <span key={i} className="pack-dictionary">{run.text}</span>
    : <Fragment key={i}>{run.text}</Fragment>));
}
