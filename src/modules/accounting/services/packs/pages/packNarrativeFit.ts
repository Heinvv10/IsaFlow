/**
 * Page 4 is the one page whose length a person controls: it prints every
 * approved commentary row as one paragraph. When that page overflows and the
 * narrative is approved, the generic layout refusal ("contact support, your
 * figures are not the problem") sends the reader to the wrong place — the fix
 * is to shorten what was approved. The diagnostic is kept as it was.
 */
import { PackRefusal } from '../packRefusal';
import { fitPageToBox } from './packPageFit';
import { relaidNarrative } from './packNarrativeLayout';
import type { MeasurablePage } from './packPageMetrics';

export function fitBodyPage<T extends MeasurablePage>(page: T): T {
  try {
    return fitPageToBox(relaidNarrative(page));
  } catch (error) {
    const approved = page.blocks.some((b) => b.kind === 'narrative' && b.narrative.status === 'approved');
    if (!(error instanceof PackRefusal) || !approved) throw error;
    throw new PackRefusal(
      error.message,
      'The approved commentary is too long for page 4 ("Commentary and actions"), so the pack '
        + 'has not been produced rather than printing that page across two sheets. Shorten an '
        + 'approved commentary sentence, or regenerate commentary with overwrite to withdraw one, '
        + 'and try again. Your figures are not the problem.',
    );
  }
}
