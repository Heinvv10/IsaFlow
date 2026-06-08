/**
 * Card — surface container with optional header/footer slots.
 * WORKING: Compound component pattern, hover variant, dark mode.
 *
 * Usage:
 *   <Card>
 *     <Card.Header title="Sales" action={<Button>...</Button>} />
 *     <Card.Body>...</Card.Body>
 *     <Card.Footer>...</Card.Footer>
 *   </Card>
 *
 * Or shorthand props:
 *   <Card header={<h2>Title</h2>} footer={<p>Total</p>}>...</Card>
 */

import * as React from 'react';
import { cn } from '@/utils/cn';

// ---------------------------------------------------------------------------
// Root Card
// ---------------------------------------------------------------------------

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Renders a standard header above the body */
  header?: React.ReactNode;
  /** Renders a standard footer below the body */
  footer?: React.ReactNode;
  /** Adds a hover shadow + cursor-pointer to indicate clickability */
  hoverable?: boolean;
  /** Remove default padding — useful when body should fill the card edge-to-edge */
  noPadding?: boolean;
}

function Card({
  className,
  header,
  footer,
  hoverable = false,
  noPadding = false,
  children,
  style,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        'border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] shadow-[0_1px_3px_rgba(0,0,0,0.06)]',
        hoverable && 'cursor-pointer transition-shadow hover:shadow-[0_4px_12px_rgba(0,0,0,0.12)] hover:border-teal-500/30',
        className
      )}
      style={{ borderRadius: 'var(--ff-card-radius)', ...style }}
      {...props}
    >
      {header && (
        <div className="border-b border-[var(--ff-border-primary)] px-5 py-4">
          {header}
        </div>
      )}

      <div className={cn(!noPadding && 'p-5')}>{children}</div>

      {footer && (
        <div className="border-t border-[var(--ff-border-primary)] px-5 py-4">
          {footer}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compound sub-components
// ---------------------------------------------------------------------------

interface CardHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

function CardHeader({ title, description, action, className }: CardHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div>
        <div className="text-base font-semibold text-[var(--ff-text-primary)]">
          {title}
        </div>
        {description && (
          <p className="mt-0.5 text-sm text-[var(--ff-text-secondary)]">{description}</p>
        )}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}

type CardBodyProps = React.HTMLAttributes<HTMLDivElement>;

function CardBody({ className, children, ...props }: CardBodyProps) {
  return (
    <div className={cn('p-5', className)} {...props}>
      {children}
    </div>
  );
}

type CardFooterProps = React.HTMLAttributes<HTMLDivElement>;

function CardFooter({ className, children, ...props }: CardFooterProps) {
  return (
    <div
      className={cn(
        'border-t border-[var(--ff-border-primary)] px-5 py-4',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

// Attach compound components
Card.Header = CardHeader;
Card.Body = CardBody;
Card.Footer = CardFooter;
Card.displayName = 'Card';
CardHeader.displayName = 'Card.Header';
CardBody.displayName = 'Card.Body';
CardFooter.displayName = 'Card.Footer';

export { Card, CardHeader, CardBody, CardFooter };
