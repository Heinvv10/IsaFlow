/**
 * Root index — redirects to /accounting (the main dashboard).
 * Server-side redirect so there is no flash of content.
 */

import type { GetServerSideProps } from 'next';

export default function IndexPage() {
  // This component is never rendered due to the server-side redirect below.
  return null;
}

export const getServerSideProps: GetServerSideProps = async () => {
  return {
    redirect: {
      destination: '/accounting',
      permanent: false,
    },
  };
};
