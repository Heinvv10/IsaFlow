/** The answer shape and the rand formatter. No server imports: the palette's client code uses both. */

export interface AskLine { label: string; value: number }
export interface AskAnswer {
  understood: boolean;
  text: string;
  /** The headline figure (rand, or a count for `bank_to_allocate`); null when there is none. */
  figure: number | null;
  lines: AskLine[];
  link: { href: string; label: string } | null;
  suggestions: string[];
}

export function rand(n: number): string {
  const [whole = '0', cents = '00'] = (Math.round(Math.abs(n) * 100) / 100).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}R ${whole.replace(/\B(?=(\d{3})+$)/g, ' ')}.${cents}`;
}
