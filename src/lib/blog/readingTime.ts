/** Reading time in whole minutes (min 1) from an MDX body, at 220 words per minute. */
export const WORDS_PER_MINUTE = 220;

export function countWords(mdx: string): number {
  const text = mdx
    .replace(/^\s*(?:import|export)\s.*$/gm, ' ') // MDX import/export lines
    .replace(/<[A-Z][\s\S]*?\/>/g, ' ') // self-closing components: their props are not prose
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ') // remaining tags; their children stay
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links keep their text
    .replace(/[#>*_`|~-]+/g, ' ');
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function computeReadingTime(mdx: string, override?: number): number {
  if (override !== undefined) return override;
  return Math.max(1, Math.ceil(countWords(mdx) / WORDS_PER_MINUTE));
}
