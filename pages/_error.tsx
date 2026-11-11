import { ErrorPageShell } from '@/components/layout/ErrorPageShell';

export default function ErrorPage() {
  return (
    <ErrorPageShell
      title="Something went wrong · IsaFlow"
      heading="Something went wrong"
      message="An unexpected error occurred. Please try again."
    />
  );
}
