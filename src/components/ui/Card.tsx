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
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-gray-200 bg-white shadow-sm',
        'dark:border-gray-700 dark:bg-gray-900',
        hoverable && 'cursor-pointer transition-shadow hover:shadow-md dark:hover:border-gray-600',
        className
      )}
      {...props}
    >
      {header && (
        <div className="border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          {header}
        </div>
      )}

      <div className={cn(!noPadding && 'p-5')}>{children}</div>

      {footer && (
        <div className="border-t border-gray-200 px-5 py-4 dark:border-gray-700">
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
        <div className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </div>
        {description && (
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{description}</p>
        )}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}

interface CardBodyProps extends React.HTMLAttributes<HTMLDivElement> {}

function CardBody({ className, children, ...props }: CardBodyProps) {
  return (
    <div className={cn('p-5', className)} {...props}>
      {children}
    </div>
  );
}

interface CardFooterProps extends React.HTMLAttributes<HTMLDivElement> {}

function CardFooter({ className, children, ...props }: CardFooterProps) {
  return (
    <div
      className={cn(
        'border-t border-gray-200 px-5 py-4 dark:border-gray-700',
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
