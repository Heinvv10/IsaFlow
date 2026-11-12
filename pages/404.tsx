import { ErrorPageShell } from '@/components/layout/ErrorPageShell';

export default function NotFoundPage() {
  return (
    <ErrorPageShell
      title="Page not found · IsaFlow"
      heading="Page not found"
      message="This page could not be found. Check the address, or use a link below."
    />
  );
}
