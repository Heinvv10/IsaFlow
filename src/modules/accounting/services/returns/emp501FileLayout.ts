/**
 * The e@syFile layout generation of an EMP501 version's filing file (wave 6 EZF). Pure, with no server imports, so the
 * returns bar (FilingFileActions) can say when a version's stored file predates the current layout.
 *
 * `emp501_easyfile@2` (EZF): the certificate fields under their SARS BRS V25.3.0 codes (3100, 3170 / 3180, 3200 / 3210),
 * ID / tax / PAYE numbers digit for digit, no province under 2065. `@1` wrote them under 3150 / 3200 / 3210 / 3215.
 * 999v's CHECK already admits any `emp501_easyfile@<n>`, so the bump needs no migration.
 */
export const EMP501_EASYFILE_KIND = 'emp501_easyfile@2';

/** What the bar says about a version whose stored file is in an earlier layout; null when there is nothing to say. */
export function emp501LayoutNote(v: { formType: string; status: string; filingFileKind: string | null }): string | null {
  if (v.formType !== 'EMP501' || v.filingFileKind === null || v.filingFileKind === EMP501_EASYFILE_KIND) return null;
  if (v.status === 'filed') {
    return `This return was filed with a file in an earlier e@syFile layout (${v.filingFileKind}). That stored file is kept as the record, and it is what downloads.`;
  }
  return `This version's stored file uses an earlier e@syFile layout (${v.filingFileKind}), with fields under the wrong SARS codes. `
    + 'The download is rebuilt in the current layout, but the version\'s stamp still names the old file: amend the return and finalise it again before you file it.';
}
