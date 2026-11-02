export interface FaqItem {
  question: string;
  answer: string;
}

function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, '$1')
    .replace(/^\s*(?:[-+*]|\d+\.)\s+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\\([\\`*{}\[\]()#+.!_-])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractFaqItems(body: string): FaqItem[] {
  const items: FaqItem[] = [];
  let question: string | null = null;
  let answerLines: string[] = [];

  const flush = (): void => {
    if (question) items.push({ question: plainText(question), answer: plainText(answerLines.join('\n')) });
    question = null;
    answerLines = [];
  };

  for (const line of body.split(/\r?\n/)) {
    const match = /^###\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      question = match[1] ?? '';
    } else if (/^#{1,2}\s+/.test(line)) {
      flush();
    } else if (question) {
      answerLines.push(line);
    }
  }
  flush();
  return items;
}

export function faqPageJsonLd(items: FaqItem[]): Record<string, unknown> & { mainEntity: unknown[] } {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}
