/**
 * The narrative page is the one page whose length a person controls: it prints
 * every approved commentary row as one paragraph. When it overflows and the
 * narrative is approved, the generic layout refusal ("contact support, your
 * figures are not the problem") sends the reader to the wrong place — the fix
 * is to shorten what was approved. The diagnostic is kept as it was.
 *
 * `pageNumber` is the sheet's place in the finished pack, passed by the
 * assembler that knows it, so the message names the page the narrative
 * actually sits on rather than one this file believes.
 */
import { PackRefusal } from '../packRefusal';
import { warnCaptionDropped } from './packOmissionFootnote';
import { fitPageReport } from './packPageFit';
import { relaidNarrative } from './packNarrativeLayout';
import type { MeasurablePage } from './packPageMetrics';

/**
 * `droppable` and `columnsLeftOut` are instructions to the fitter, not part of the page: a page that
 * survived the fit leaves the composer exactly as it was before they existed, so the document is
 * unchanged where nothing was dropped.
 */
function withoutFitterMarks<T extends MeasurablePage>(page: T): T {
  const marked = page.blocks.some((b) => b.kind === 'narrative' && b.droppable !== undefined);
  if (!marked && page.columnsLeftOut === undefined) return page;
  const { columnsLeftOut: unused, ...rest } = page;
  return {
    ...rest,
    blocks: page.blocks.map((b) => {
      if (b.kind !== 'narrative' || b.droppable === undefined) return b;
      const { droppable: unusedMark, ...bare } = b;
      return bare;
    }),
  } as T;
}

export function fitBodyPage<T extends MeasurablePage>(page: T, pageNumber: number): T {
  try {
    const { page: fitted, dropped } = fitPageReport(relaidNarrative(page));
    // Logged here, for the page that is actually used (see `warnCaptionDropped`).
    warnCaptionDropped(page.navLabel, dropped);
    return withoutFitterMarks(fitted);
  } catch (error) {
    const approved = page.blocks.some((b) => b.kind === 'narrative' && b.narrative.status === 'approved');
    if (!(error instanceof PackRefusal) || !approved) throw error;
    throw new PackRefusal(
      error.message,
      `The approved commentary is too long for page ${pageNumber} ("${page.navLabel}"), so the pack `
        + 'has not been produced rather than printing that page across two sheets. Shorten an '
        + 'approved commentary sentence, or regenerate commentary with overwrite to withdraw one, '
        + 'and try again. Your figures are not the problem.',
    );
  }
}
