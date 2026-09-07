import { describe, it, expect } from 'vitest';
import { formatDays, formatMoney, formatPct, formatPctLevel, formatRatio, pctWithWord, signOf, MONEY_SCALES, toMoneyScale } from '@/lib/format/money';

describe('formatMoney', () => {
  it('uses thousands separators and no decimals by default', () => {
    expect(formatMoney(4812345.67)).toBe('4 812 346');
  });
  it('shows negatives in parentheses, never a minus', () => {
    expect(formatMoney(-2190000)).toBe('(2 190 000)');
    expect(formatMoney(-2190000)).not.toContain('-');
  });
  it('shows cents when asked', () => {
    expect(formatMoney(53787.07, { cents: true })).toBe('53 787.07');
  });
  it('prefixes the rand symbol when asked', () => {
    expect(formatMoney(1000, { symbol: true })).toBe('R 1 000');
    expect(formatMoney(-1000, { symbol: true })).toBe('(R 1 000)');
  });
  it('renders zero as a dash', () => {
    expect(formatMoney(0)).toBe('–');
  });
  it('treats -0.004 as zero, not a negative', () => {
    expect(formatMoney(-0.004)).toBe('–');
  });
});

describe('formatPct', () => {
  it('signs positive and negative, one decimal', () => {
    expect(formatPct(6.94)).toBe('+6.9%');
    expect(formatPct(0)).toBe('0.0%');
  });
  // ONE negative convention across the module, and asserted on the CHARACTER.
  // A rendered pack carried `(1 546)`, `−1348.0%` and `-0.14` within a few
  // rows of each other — an accounting bracket, a U+2212 and an ASCII hyphen
  // for one idea. `not.toContain('-')` alone passes on a U+2212, which is how
  // the percentage formatter kept its own marker while the money formatter
  // was pinned to brackets.
  it('shows a negative percentage in brackets, with no minus of either kind', () => {
    expect(formatPct(-8.1)).toBe('(8.1%)');
    expect(formatPct(-8.1)).not.toContain('-');       // ASCII hyphen U+002D
    expect(formatPct(-8.1)).not.toContain('\u2212');  // minus sign U+2212
  });
});

describe('formatRatio and formatDays', () => {
  it('use the same bracket, never a hyphen', () => {
    expect(formatRatio(0.14)).toBe('0.14');
    expect(formatRatio(-0.14)).toBe('(0.14)');
    expect(formatRatio(-0.14)).not.toContain('-');
    expect(formatDays(63.7, 1)).toBe('63.7 days');
    expect(formatDays(-12)).toBe('(12 days)');
    expect(formatDays(-12)).not.toContain('-');
  });
  it('keeps a measured zero as a zero, and a non-figure as a dash', () => {
    // Not the en dash: 0.00 is a ratio someone measured. The dash is this
    // module's word for a figure that is not there at all.
    expect(formatRatio(0)).toBe('0.00');
    expect(formatRatio(NaN)).toBe('–');
    expect(formatDays(Infinity)).toBe('–');
  });
});

describe('formatPctLevel', () => {
  it('states a level with no leading plus, and a negative in brackets', () => {
    expect(formatPctLevel(63.7)).toBe('63.7%');
    expect(formatPctLevel(-1348)).toBe('(1348.0%)');
    expect(formatPctLevel(NaN)).toBe('–');
  });
});

describe('pctWithWord', () => {
  // THE DEFECT THIS TYPE EXISTS FOR. `formatPctMagnitude` was exported for
  // prose that carries direction in a word, and two sentences were then
  // written that carry none: a board pack's largest type read "Gross margin
  // of 1348.0%" two centimetres above its own table reading the negative of
  // it. There is now no exported way to obtain an undirected percentage, so
  // the word and the number come out together.
  it('carries the direction of a NEGATIVE value into the string', () => {
    expect(pctWithWord(-1348, 'a positive', 'a negative')).toBe('a negative 1348.0%');
    expect(pctWithWord(-8.1, 'up', 'down')).toBe('down 8.1%');
  });
  it('matches formatPct rounding, and reads zero as the positive word', () => {
    expect(pctWithWord(6.94, 'up', 'down')).toBe('up 6.9%');
    expect(pctWithWord(0, 'up', 'down')).toBe('up 0.0%');
  });
  it('renders a dash for a non-finite figure, with no direction word', () => {
    expect(pctWithWord(NaN, 'up', 'down')).toBe('–');
    expect(pctWithWord(Infinity, 'up', 'down')).toBe('–');
  });
});

describe('signOf', () => {
  it('classifies', () => {
    expect(signOf(5)).toBe('pos'); expect(signOf(-5)).toBe('neg'); expect(signOf(0)).toBe('zero');
  });
});

describe('non-finite figures', () => {
  // A statement column is the last place a "NaN" should surface. Before this
  // guard signOf fell through to 'pos' and the grid printed "NaN" and
  // "+NaN%" in a money column, which reads as a figure.
  it('signOf treats a non-finite number as zero', () => {
    expect(signOf(NaN)).toBe('zero');
    expect(signOf(Infinity)).toBe('zero');
    expect(signOf(-Infinity)).toBe('zero');
  });

  it('formatMoney renders a dash rather than the word NaN', () => {
    expect(formatMoney(NaN)).toBe('–');
    expect(formatMoney(NaN, { cents: true, symbol: true })).toBe('–');
    expect(formatMoney(Infinity)).toBe('–');
  });

  it('formatPct renders a dash rather than 0.0% or +NaN%', () => {
    // Not "0.0%": a percentage that could not be computed must not read as a
    // percentage of zero.
    expect(formatPct(NaN)).toBe('–');
    expect(formatPct(Infinity)).toBe('–');
    expect(formatPct(0)).toBe('0.0%');
  });
});


describe('formatMoney scaling', () => {
  // The defect this pins: a table headed "R'000" whose cells were formatted
  // unscaled printed R4 200 000 as `4 200 000`, which a director reads as
  // R4.2bn. Nothing caught it because no assertion read a cell against its
  // own header.
  it("prints a thousands-scaled figure under an R'000 header", () => {
    expect(formatMoney(4_200_000, { scale: "R'000" })).toBe('4 200');
  });

  it('leaves every existing caller byte-identical when no scale is given', () => {
    for (const n of [4_200_000, -1_234, 0, 999.4]) {
      expect(formatMoney(n, { scale: undefined })).toBe(formatMoney(n));
    }
  });

  it('keeps the sign convention after scaling', () => {
    expect(formatMoney(-4_200_000, { scale: "R'000" })).toBe('(4 200)');
  });

  it('distinguishes a figure that rounds to nothing from an actual zero', () => {
    // R400 is less than half a thousand, so under an R'000 header it survives
    // the scale as nothing. It printed `0` — and the board pack's matters page
    // listed journals a board was being asked to decide on with a quantum
    // column of `0`, which a reader takes to mean no money is involved. It is
    // the mirror of the 1000x misread: one direction prints thousands as
    // rands, the other prints rands as nothing.
    //
    // `<1` states the bound. The dash stays reserved for a MEASURED zero, so
    // all three readings remain distinct: an amount under one unit, nothing,
    // and unavailable.
    expect(formatMoney(400, { scale: "R'000" })).toBe('<1');
    expect(formatMoney(-400, { scale: "R'000" })).toBe('(<1)');
    expect(formatMoney(400, { scale: "R'000", symbol: true })).toBe('R <1');
    expect(formatMoney(0.4)).toBe('<1');
    // Cents already print the real amount, so there is nothing to bound.
    expect(formatMoney(0.4, { cents: true })).toBe('0.40');
    expect(formatMoney(0, { scale: "R'000" })).toBe('–');
    // And a figure that does survive the scale is untouched.
    expect(formatMoney(1_400, { scale: "R'000" })).toBe('1');
  });

  it('reaches the bound for the amounts the pack actually carries', () => {
    // THE GUARD USED TO STOP ONE RUNG SHORT OF ITS OWN DEFECT. The zero test
    // read the SCALED number, and `signOf` answers 'zero' under half a printed
    // unit — so at `R'000` every amount below R5 printed the dash, which is
    // this formatter's word for a MEASURED zero, and `<1` was unreachable
    // there. R400 (above) was inside the window; R4 was not, and the matters
    // page's quantum column is where an exposure of R4 lands.
    expect(formatMoney(4, { scale: "R'000" })).toBe('<1');
    expect(formatMoney(-4, { scale: "R'000" })).toBe('(<1)');
    expect(formatMoney(0.01, { scale: "R'000" })).toBe('<1');
    // At millions the same window is a thousand times wider.
    expect(formatMoney(4_000, { scale: "R'm" })).toBe('<1');

    // AND THE OTHER DIRECTION, which is why the tolerance did not move: half a
    // cent is not an amount. A statement total is a subtraction, and float
    // residue off one must read as the measured zero it is rather than as
    // money too small to show.
    expect(formatMoney(0.004, { scale: "R'000" })).toBe('–');
    expect(formatMoney(-0.004)).toBe('–');
    expect(formatMoney(0)).toBe('–');
  });

  it('scales millions too', () => {
    expect(formatMoney(4_200_000, { scale: "R'm" })).toBe('4');
    expect(MONEY_SCALES["R'm"]).toBe(1_000_000);
  });

  it('narrows a known scale string and refuses an unknown one', () => {
    expect(toMoneyScale("R'000")).toBe("R'000");
    expect(toMoneyScale('thousands')).toBeNull();
  });
});
