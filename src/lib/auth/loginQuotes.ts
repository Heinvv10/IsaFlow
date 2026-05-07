export interface LoginQuote {
  text: string;
  author: string;
  role: string;
  theme: 'integrity' | 'customer-value' | 'learning' | 'leadership' | 'accountability';
  sourceUrl: string;
}

export const LOGIN_QUOTES: LoginQuote[] = [
  {
    text: 'We will always tell you how many strokes we have taken on each hole and never play around with the scorecard.',
    author: 'Warren Buffett',
    role: 'Chairman and CEO, Berkshire Hathaway',
    theme: 'integrity',
    sourceUrl: 'https://www.berkshirehathaway.com/ownman.pdf?v=1694822476156',
  },
  {
    text: 'To satisfy the customer is the mission and purpose of every business.',
    author: 'Peter Drucker',
    role: 'Management thinker and author',
    theme: 'customer-value',
    sourceUrl: 'https://drucker.institute/principles-underlying-the-drucker-institutes-company-rankings/',
  },
  {
    text: "Developing talent is business' most important task.",
    author: 'Peter Drucker',
    role: 'Management thinker and author',
    theme: 'leadership',
    sourceUrl: 'https://drucker.institute/principles-underlying-the-drucker-institutes-company-rankings/',
  },
  {
    text: 'Intelligence plus character - that is the goal of true education.',
    author: 'Martin Luther King Jr.',
    role: 'Civil rights leader',
    theme: 'integrity',
    sourceUrl: 'https://kinginstitute.stanford.edu/king-papers/documents/purpose-education',
  },
  {
    text: 'Education is the most powerful weapon which you can use to change the world.',
    author: 'Nelson Mandela',
    role: 'Former President of South Africa',
    theme: 'learning',
    sourceUrl: 'https://www.nelsonmandela.org/nm100-education',
  },
  {
    text: 'Do the best you can until you know better. Then when you know better, do better.',
    author: 'Maya Angelou',
    role: 'Author and poet',
    theme: 'accountability',
    sourceUrl: 'https://www.quotenova.net/authors/maya-angelou/qab6wz',
  },
];

function getLocalDayOfYear(date: Date): number {
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((startOfDay.getTime() - startOfYear.getTime()) / 86_400_000);
}

export function getDailyLoginQuote(date = new Date()): LoginQuote {
  return LOGIN_QUOTES[getLocalDayOfYear(date) % LOGIN_QUOTES.length] as LoginQuote;
}
