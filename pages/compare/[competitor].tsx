/**
 * Public comparison pages: /compare/sage, /compare/xero, /compare/quickbooks,
 * /compare/simplepay, /compare/payspace.
 * Static, unauthenticated, marketing host only (see middleware isMarketingOnlyPath).
 */
import type { GetStaticPaths, GetStaticProps } from 'next';
import { ComparePage } from '@/components/landing/ComparePage';
import { COMPARE_ENTRIES, getCompareEntry, type CompareEntry } from '@/lib/compare/compareData';

interface Props {
  entry: CompareEntry;
}

export const getStaticPaths: GetStaticPaths = async () => ({
  paths: COMPARE_ENTRIES.map((e) => ({ params: { competitor: e.slug } })),
  fallback: false,
});

export const getStaticProps: GetStaticProps<Props> = async ({ params }) => {
  const entry = getCompareEntry(String(params?.competitor ?? ''));
  if (!entry) return { notFound: true };
  return { props: { entry } };
};

export default function CompareCompetitorPage({ entry }: Props) {
  return <ComparePage entry={entry} />;
}
