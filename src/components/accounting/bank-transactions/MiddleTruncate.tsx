/** MiddleTruncate — a name clipped in the middle: the ending (the part that tells two similar accounts apart) always shows. */

import { splitName } from './bankCardPins';

export function MiddleTruncate({ name, className = '', testId }: { name: string; className?: string; testId?: string }) {
  const { head, tail } = splitName(name);
  return (
    <span title={name} data-testid={testId} className={`flex min-w-0 ${className}`}>
      <span className="truncate">{head}</span>
      {tail && <span className="shrink-0 whitespace-pre">{tail}</span>}
    </span>
  );
}
