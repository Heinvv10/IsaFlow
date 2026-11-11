import { ErrorPageShell } from '@/components/layout/ErrorPageShell';

export default function ErrorPage() {
  return (
    <ErrorPageShell
      title="Something went wrong · IsaFlow"
      heading="Something went wrong"
      message="This page could not be loaded because of an unexpected error. Try again, or use a link below."
    />
  );
}
