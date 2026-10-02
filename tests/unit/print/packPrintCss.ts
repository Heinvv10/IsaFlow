/**
 * The pack print stylesheet AS ONE TEXT, in cascade order.
 *
 * `styles/packPrint.css` is an entry file: it `@import`s its partials and
 * states no rule of its own. A test that reads it by path would be reading
 * four import lines — every rule assertion would be made against nothing, and
 * a harness that inlines it into a `<style>` would hand Chromium imports it
 * cannot resolve. So each partial is inlined where its `@import` stands,
 * which is the order the bundler emits them in.
 *
 * FAILS CLOSED. A partial that is missing throws from `readFileSync`, and an
 * `@import` this did not recognise — another quote style, a URL — throws
 * rather than leaving a line of the stylesheet unread.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PARTIAL_IMPORT = /@import\s+'\.\/([\w.-]+\.css)';/g;

export function readPackPrintCss(root: string = process.cwd()): string {
  const styles = path.join(root, 'styles');
  const entry = readFileSync(path.join(styles, 'packPrint.css'), 'utf8');
  const inlined = entry.replace(PARTIAL_IMPORT, (_line, file: string) =>
    readFileSync(path.join(styles, file), 'utf8'));
  const rules = inlined.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/@import/.test(rules)) {
    throw new Error('readPackPrintCss: styles/packPrint.css carries an @import this reader did not inline.');
  }
  return inlined;
}
