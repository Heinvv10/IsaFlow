/**
 * THE WIDTH OF A KPI TILE'S NOT-MEANINGFUL REASON, IN DEVICE PIXELS, AS CHROMIUM LAYS IT OUT.
 *
 * `.pack-kpi-unavailable` is 11pt (14.667px) italic, and the pack's italic cut of IBM Plex Sans is a real face with
 * its own advances ("nnnnnnnnnnnnnnnnnnnn" is 160px in it and 180px in the regular face the figure ruler uses at
 * 15px). Each glyph's advance is a whole number of pixels at this one size, measured between two bars through the
 * class itself; `packFigureWidth.test.ts` re-measures every entry and fails if one drifts.
 *
 * It covers every code point it can: Basic Latin, Latin-1 and Latin Extended-A (U+0020 to U+017F), then Latin Extended-B
 * to Cyrillic (U+0180 to U+04FF), U+1E00 to U+2BFF and the mathematical alphanumerics (U+1D400 to U+1D7FF) (Latin Extended Additional, Greek Extended, punctuation,
 * currency, letterlike symbols, arrows, mathematical operators, technical, box drawing, shapes, miscellaneous symbols and
 * dingbats) one by one; every other BMP or astral block of 32 code points by the WIDEST glyph it holds, rounded up
 * (mathematical alphanumerics, CJK, Hangul, emoji, the scripts of the world: fallback fonts, so each is an upper
 * bound for any glyph in the block, not a measure of it). Beyond U+1FFFF a glyph is charged 18px. An upper
 * bound that is not the 14px a typical glyph measures at 6 to 9.
 *
 * Noto Color Emoji sets every emoji (astral or BMP: the check mark, the warning sign) at 18px, CJK at 13 to 15,
 * Cyrillic and Greek at 9 to 14; an Arabic ligature sign can be 106px (U+FDFD), so the blocks are not a flat 18. The variation selector and the zero-width joiner add nothing to their base glyph's width (a heart is
 * 18px with or without one, a three-person family 18px in all), so they are charged 0 and their base 18.
 */
// U+0020 to U+017F in order; U+007F to U+009F are controls (0, charged as unknown below).
const LATIN: readonly number[] = [
  3, 4, 6, 10, 9, 14, 10, 4, 5, 5, 7, 9, 4, 6, 4, 6,
  9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 4, 4, 9, 9, 9, 7,
  13, 9, 10, 9, 10, 9, 8, 10, 10, 6, 7, 9, 7, 12, 10, 10,
  9, 10, 9, 9, 8, 10, 9, 13, 9, 9, 9, 5, 6, 5, 9, 8,
  9, 8, 9, 7, 9, 8, 5, 8, 8, 4, 4, 8, 4, 13, 8, 8,
  9, 9, 5, 7, 5, 8, 7, 11, 7, 7, 7, 5, 5, 5, 9, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  3, 4, 8, 9, 9, 9, 5, 9, 9, 11, 6, 8, 9, 0, 7, 9,
  7, 9, 5, 5, 9, 8, 10, 5, 9, 5, 6, 8, 12, 13, 12, 7,
  9, 9, 9, 9, 9, 9, 13, 9, 9, 9, 9, 9, 6, 6, 6, 6,
  10, 10, 10, 10, 10, 10, 10, 9, 10, 10, 10, 10, 10, 9, 9, 9,
  8, 8, 8, 8, 8, 8, 13, 7, 8, 8, 8, 8, 4, 4, 4, 4,
  8, 8, 8, 8, 8, 8, 8, 9, 8, 8, 8, 8, 8, 7, 9, 7,
  9, 8, 9, 8, 9, 8, 9, 7, 9, 7, 9, 7, 9, 7, 10, 9,
  10, 9, 9, 8, 9, 8, 9, 8, 9, 8, 9, 8, 10, 8, 10, 8,
  10, 8, 10, 8, 10, 8, 10, 8, 6, 4, 6, 4, 6, 4, 6, 4,
  6, 4, 9, 7, 7, 4, 9, 8, 8, 7, 4, 7, 4, 7, 4, 7,
  5, 7, 4, 10, 8, 10, 8, 10, 8, 12, 10, 8, 10, 8, 10, 8,
  10, 8, 14, 14, 9, 5, 9, 5, 9, 5, 9, 7, 9, 7, 9, 7,
  9, 7, 8, 5, 8, 5, 9, 5, 10, 8, 10, 8, 10, 8, 10, 8,
  10, 8, 10, 8, 13, 11, 9, 7, 9, 9, 7, 9, 7, 9, 7, 4,
];
/** U+0180 to U+04FF, U+1E00 to U+2BFF, then U+1D400 to U+1D7FF (mathematical alphanumerics), one base-36 digit per code point (widths of 35 or more are capped at 35). */
const EXACT =
  '9a9999997ab9998a897a9d559848fb9ba8fca9987855858a8ba88878877887795884ihgcb8ffd9864a8a8a8a8a8a889898dd'
  +   'a8a898a8a8874ihga8eaa898dda8999988885454b9b99696a9a9978598a8bca9879898a8a8a8a8975a64ee9978877779a988'
  +   '54b996879999789988b77a9499877999455654addd9999cca67666558874444559997b7778776667b8999487966eefb8cca9'
  +   '8999663444675369933344555599364536545533444599999945535547777777686775555777456559990000040000000444'
  +   '4404404444404444444044000444444444444444444444440044044444444440444444444444444444444444444444447698'
  +   '44b9ff477745ffff99949b7fafaa49a7999aa699ca9aa9f889c9ca6998848997886884878778987978a7bb4888b9898a8ac9'
  +   'b997877897dda9a8aa99b9769974b77999db999999c799667ffcaa9a99a7b9e9aaaacaaa9989c9b9efbd99e9888698b79988'
  +   'a9889777b798cc9b87b8888677444cc88978eca8db98dbdbec87bba8a897igb9fcec9794444444b99899768798eb97a8a9a8'
  +   'b9b9dbfcda9787979798daa89898c9c96eba8a9a9b9a9db49898dd98a8a8eb9797a9a9a8a8a8979797979876db76888899a9'
  +   'a99997a9a9a9a9a9989888889885a8a8a8a8a8a9546498989874748484cdcdcda8a8b9b9a8a8a8a899999595959697979797'
  +   '9785858585a9a9a9a8a89797dbdbdbdbdb97979797978795b79455a998989898989898989898989898989898989898986464'
  +   'a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a897979797b8a9979999999999aaaaaa777777ff99bbbbff99999999cceeedee'
  +   '5555555577999999999999ffcceeeeff99999999fafcfcfcbbbbbbbbcceeeeee998888448888bbff99999999ddffffff9999'
  +   '9999ggiiiiiibbbbbbbbhhjjjjii99999f999999d44499999f9999abf9994444ff556667f99988889999999aa999ffbbbfbb'
  +   'aaaag94f7f7f5429421000006699bf9644437776886688c433000002jm469479644d876885h5255dbb89aa94896f898bdd4a'
  +   'c443000000000000000064ff555565555336655555556555533565655764a6654fff99999dabaeb9999f99a9999a999ab999'
  +   '7fffffffffffffff777777777777777777777777777777774fffffffffffffffbaae9cc89c9gbc99b9d7ccfddacedb99cca9'
  +   'a8ab9599dab79d7h898674elc89caa888b9866baab7gddgddddccdcdddc747aeaegjdaeh8abd479c9cfhc9cf489eibia7a8b'
  +   'gd88ffffccccccccccffddd6d6ccc6c68ccddefccccca9cccfcccc66cc66cbccbcbcccfcc9c9f9aaaaccdd66c6c6cccccccc'
  +   'cccccddccbcccdccdddfb6988c99aa8aa88aa7988267659998bfaa83659aaba69d8cg9998848898888aa4888888899888888'
  +   '888899888888888899f8998888cc5899998888888888888888aaaaaaaaaa999899999bebebeeeebbbbbbbb77bcccbbcc8888'
  +   '88ddc88888aaddbb9378bbbbb8bbaaaaa988hh888888888888888888884cccca8aa8aaca8a8a999cccc76666cccc98fc9888'
  +   'f8ii666699aahhlhl55ldbbcabbbcbb7bbbbbab88bbbbaabbab8bbbabb8bbbab68d6aabbbb986aaab85bbb6bbbb59b975b98'
  +   'eba4ccccgcchccccca7cccccdbccccc44444444444444444446f5599bbbafffffffffffffffffffffbce7555999aaaffhhpp'
  +   'ppcdcbcc9iiiiddcibbi77cc777ccccacbccbccccccccccccccccccccccccccccc99cccfffffffffffffffffffffffff9999'
  +   '9999999fffffffffffffffffffffggggggggggggggggggggffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffb9a999999999'
  +   'b999b999b999b999b9999999b9999999b9999999b9999999b9999999999999999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbb999'
  +   '9999999999999999bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb99eeeeeeee66fe86bbfd77bc77fbfd77bc77fbbbbd999dd99999'
  +   '999999ee6666ddbbbb6eeeeebbbgeeeeddddbbbaciibdfddddd8ddddafiiddd8iidddddddid9ddddabab8dddeddddddddddd'
  +   'dffgeddbbbbbbbbbiiiiiiiiiiiidddddddddddd8ddad98ddf8bf558dddddddddddddddidddddddddddddddddddid8dddddd'
  +   'dedddifghdcccciiccccccbbbbcbb9aaaiibcccciicccbbbbdiccefaicccccacdbdkddb9ccccbeidacfcceiiiiadeiibbicb'
  +   'eccccicccciiiicccccdccccccccccccccccccccicccccccccccccccccccccccccccccccccccddiddddiiidiccc55886accc'
  +   'ccccccccccccccccccddddddddddccccccccccccccccccccciiiccccccccccccccccccccccccicccccccccccccciadbaa66a'
  +   'ff5dfdbbda9aaeehbbjjcdd69cdddd7766885555bbffdhhihhihhhhjbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  +   'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  +   'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  +   'bbbbbbbbbbbbddccedcc66bbccccec66cceeeccccccccaaaaaaaaaaaaaaaaaad99aa99gfggcceeccccccd8cc66c6c6cc66cc'
  +   '66cc67cc66cacaccccccccaafccccc8d8bebbb99a667766555555555566bbbb4435aaaaa89aaaa99aaaacccccccccgeeeecc'
  +   'eceeeegfbbbbbedddeceebbbbbbb5588bbbdb8caaac9eed9bb99ccaad66866bd7799eeebbbbffdcah7777977987988877d85'
  +   'd588888988888bb8888abbeeeddd885aaaaaa97777ccbcbbbaaaabbaaaaabbaaa8aabb88bb8888888888cdj8baa888888888'
  +   '88888888888888888888888888888ccdagbbbbaaaa8888888888888ccaaaaaaaaaaaaaaaaffaaaaaaaajj9aa997bbbbcbccb'
  +   'bbbb886666888b3ee88b8966cccccccccccccccccceeeebbbbeii44dddddgaa77544dd99ccdjdddeccceeecdcccdeccccccc'
  +   'cc55i88ddicccccc99bbc7c7c8aaaab5b5ccb5b5ff9999b5b5b9ccccccccbbbbccccddbbhfffacacacbccccc9999eeee9999'
  +   'cccccccc9cccccccccccccccc8ccbbbbbc6eefg9fbdaa9bebdafb8gd88eec9c9f8acggcdbbfi89a9aaaba9bb67b9ebb9ba99'
  +   'b9da9a886875784584c8788665879776aaaba9cb56aadbb9ba89bada9a7778646f4474c887755486a66699aba9bb5799daa9'
  +   'a989a9c889776764784474b8777664869766afabffaff8bff98a9f99d9daa78759f8f85576b8f8865687a687bdab8bac98b9'
  +   'ca8a9d99d9eaa7876968885586c878865697b786acfc98bff998ebbabfb99cf8bf665653663353a7666464669664aafb88af'
  +   '56a8dfbfff89aada9f8a7a85aa5595e99aa675a9e987bdbcbacb9ab9gdbbddc9adgac9776764775474b877757587a7759a9b'
  +   '88bb5498dbb9b988b9e988897985994484e999967597c877aa9b88bb65a8ecc9ca88baea989989969a4494ea999776a8d887'
  +   '899a87aa5487cab8b877a8d878887875884474d888866587b777999a88aa6598dbb9b988a9d988997985994484d999967698'
  +   'c887999999999999999999999999999999999999999999999999999944ffcaababde7bcgdbddaea9bdbdeba9a77799589999'
  +   '9b88a99bace98adc9fdbacacee6beiecedbebadecegccac989a9699bb9ac98baacadf99adc9hcaab9bde7bcgdbddaea9bdbd'
  +   'fbb99777995889989a88a99b9ce98acc9faa9aa9bc4a9db9cbac999b9cba998987994879879a98969a8bb889ab8b9a8a99bc'
  +   '598db9cbac988b8cca997987994879789998979a7bb8899b8ba9ff8888888888999999999988888888888888888888999999'
  +   '9999';
/** U+0500 to U+1DFF, a digit per block of 32 code points: the widest glyph in it. */
const BLOCKS_LOW =
  'fjfef6ffvjefjfkjigiiffcfgjhffj7kfeefhfjfhffmhfffmiqfuozxljlqnksntkwwpllmffffffffknffffofizhigfgedddd'
  +   'ddddgefbffhdfiffjgjgdfedccffhhedhdcedhelfbbfgfffietffihihfhgffffejfmjhkffkffmiqkgohgfgfbhfpfdb9dd947';
/** U+2C00 to U+FFFF, a digit per block of 32. */
const BLOCKS_BMP_HIGH =
  'gjfecfffefcfikf4gzfffffffffffffffiffffffffddffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffddffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffaaccaaa9a99a999a9a999a999aaa99a9ba9afcfekgeefefikffjjbbf8gjfcfgfefchddfc'
  +   'cdffmktinjkliiogfidffdefdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
  +   'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
  +   'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
  +   'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddfff000000000000000000000000'
  +   '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
  +   '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
  +   '0000000000000000000000000000000000000000ffffffffffffffffmfggeefglnjiinimopxytyxzffffgkgfffff7fff';
/** U+10000 to U+1FFFF, a digit per block of 32. */
const BLOCKS_ASTRAL =
  'ffffioskffekhffffffffefflfffkkkfcbabffffcfcfffffefeihhhhejiffffffffhffffffffmonqfffacfihjhhigiffcdff'
  +   'ffbfcffffffffffhbffffjoffffhceffdfffgfggcbgthgfffiffzohqffffedklfbffffffdfffcbfhbfffhjffffffeffffcdf'
  +   'ffffffffhcfaifcffff77777gffffffffhffffffffffffffffffffrquzzzzqnvxzzxztgszyzzzwysxzzzzfffuzmnzzzzzzxf'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffkjiimsrppimroouk'
  +   'mjknlklllkmnpjjlmiffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffnkmnkmmlihklilignjnfffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffghhhleieeghlfhgejfffffffddffffffffffffffffffffffffidffffccf7ffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffddefeefffgffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffikcffhffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  +   'ffffffffffffffffffffffffffffffffffffffffffffffffffffffff7fffffffjmmmbb9fch88mahlddffffffddffffffecfd'
  +   'fffefffggeeedddd9geihgfddcf9ffffffffffffffff7f7fffffffffffffffffffffffffffffffffffffffffffffff7fffff'
  +   'bfffffffffffffcfffffffffffffffffffffffffffffffffffffffffjhhiihffedfffffffffffffffffffffffffwvtffffff'
  +   'ffffgfjgggfhffffffffikkkffifffffifffiiifffffiiiiiiiiiiiiiiiiiiijjkikiiijiiiihklkcdfifffcffffiiiiiiii'
  +   'fffiiiiiffffffffffffffffffffffffffffffffffffffff';
/** Blocks wider than a base-36 digit holds (an Arabic ligature sign, cuneiform numerals), by the block's first code point. */
const WIDE_BLOCKS: Readonly<Record<number, number>> = {
  3008: 40,
  4128: 36,
  11808: 42,
  64992: 106,
  70400: 41,
  73760: 53,
  73792: 48,
  73824: 39,
  74016: 46,
  74048: 45,
  74112: 37,
  74240: 59,
  74304: 36,
  74336: 38,
  74368: 42,
  74528: 37,
  74560: 42,
  74592: 39,
  74624: 37,
  74784: 68,
  74880: 48,
  74912: 36,
  74944: 36,
  74976: 39,
  75008: 43,
  75040: 36,
};
const WIDEST_PX = 18;
/** U+200D (joiner) and U+FE0E/FE0F (variation selectors) combine with the glyph before them. */
const ZERO_WIDTH = new Set([0x200d, 0xfe0e, 0xfe0f]);
const BLOCK = 32;

const digit = (table: string, index: number): number => Number.parseInt(table[index]!, 36);

function blockWidth(table: string, base: number, code: number): number {
  const index = (code - base) >> 5;
  const wide = WIDE_BLOCKS[base + index * BLOCK];
  return wide ?? digit(table, index);
}

function advance(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (ZERO_WIDTH.has(code)) return 0;
  let px: number;
  if (code >= 0x20 && code <= 0x17f) px = LATIN[code - 0x20]!;
  else if (code >= 0x180 && code <= 0x4ff) px = digit(EXACT, code - 0x180);
  else if (code >= 0x1e00 && code <= 0x2bff) px = digit(EXACT, 0x380 + code - 0x1e00);
  else if (code >= 0x1d400 && code <= 0x1d7ff) px = digit(EXACT, 0x380 + 0xe00 + code - 0x1d400);
  else if (code >= 0x500 && code <= 0x1dff) px = blockWidth(BLOCKS_LOW, 0x500, code);
  else if (code >= 0x2c00 && code <= 0xffff) px = blockWidth(BLOCKS_BMP_HIGH, 0x2c00, code);
  else if (code >= 0x10000 && code <= 0x1ffff) px = blockWidth(BLOCKS_ASTRAL, 0x10000, code);
  else px = WIDEST_PX;
  // A combining mark advances nothing; anything else the table holds as 0 is a control or unassigned: the widest.
  if (px === 0) return /\p{M}/u.test(ch) ? 0 : WIDEST_PX;
  return px;
}

export function reasonPx(text: string): number {
  let px = 0;
  for (const ch of text) px += advance(ch);
  return px;
}
