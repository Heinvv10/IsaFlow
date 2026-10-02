/**
 * `next/dynamic` for a plain browser bundle: the loader's module, loaded
 * lazily, with the same `ssr: false`-free semantics the print page needs.
 */
import { lazy, Suspense, type ComponentType } from 'react';

export default function dynamic<P extends object>(
  loader: () => Promise<{ default: ComponentType<P> } | ComponentType<P>>,
): ComponentType<P> {
  const Lazy = lazy(async () => {
    const mod = await loader();
    return 'default' in (mod as object) ? (mod as { default: ComponentType<P> }) : { default: mod as ComponentType<P> };
  });
  return function Dynamic(props: P) {
    return <Suspense fallback={null}><Lazy {...(props as P & Record<string, unknown>)} /></Suspense>;
  };
}
