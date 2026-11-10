/** The SA scripts' marks and the bases they are written on (`packFallbackMarksImage.test.ts`, `packProseDictionaryImage.test.ts`). */
/** A consonant of each SA script, the base a mark of it is written on. */
const BASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\p{Script=Thai}/u, 'ก'], [/\p{Script=Lao}/u, 'ກ'], [/\p{Script=Myanmar}/u, 'က'], [/\p{Script=Khmer}/u, 'ក'],
  [/\p{Script=Tai_Le}/u, 'ᥐ'], [/\p{Script=New_Tai_Lue}/u, 'ᦀ'], [/\p{Script=Tai_Tham}/u, 'ᨠ'], [/\p{Script=Tai_Viet}/u, 'ꪀ'],
  [/\p{Script=Ahom}/u, '\u{11700}'],
];
export const markBase = (ch: string): string | null => BASES.find(([re]) => re.test(ch))?.[1] ?? null;
