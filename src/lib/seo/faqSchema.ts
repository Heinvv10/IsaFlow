/** FAQPage JSON-LD builder. The schema text is the visible text, verbatim. */
export interface FaqEntry {
  q: string;
  a: string;
}

export function buildFaqPage(id: string, items: readonly FaqEntry[]): Record<string, unknown> {
  return {
    '@type': 'FAQPage',
    '@id': id,
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

/** Serialise JSON-LD for an inline script tag (escape "<" so text cannot close the tag). */
export function jsonLdScriptText(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
