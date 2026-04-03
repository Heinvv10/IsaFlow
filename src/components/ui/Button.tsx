/**
 * Button — primary interactive element with variants, sizes, icons, and loading state.
 * WORKING: CVA-based variants, Radix Slot asChild support, forward ref.
 */

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';
import { LoadingSpinner } from './LoadingSpinner';

const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 rounded-md font-medium',
    'transition-colors duration-150 focus-visible:outline-none',
    'focus-visible:ring-2 focus-visible:ring-offset-2',
    'disabled:pointer-events-none disabled:opacity-50',
    'select-none whitespace-nowrap',
  ],
  {
    variants: {
      variant: {
        primary: [
          'bg-teal-600 text-white',
          'hover:bg-teal-700',
          'focus-visible:ring-teal-500',
          'dark:bg-teal-500 dark:hover:bg-teal-600',
        ],
        secondary: [
          'border border-gray-300 bg-white text-gray-700',
          'hover:bg-gray-50 hover:border-gray-400',
          'focus-visible:ring-teal-500',
          'dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200',
          'dark:hover:bg-gray-700 dark:hover:border-gray-500',
        ],
        ghost: [
          'bg-transparent text-gray-700',
          'hover:bg-gray-100 hover:text-gray-900',
          'focus-visible:ring-teal-500',
          'dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100',
        ],
        danger: [
          'bg-red-600 text-white',
          'hover:bg-red-700',
          'focus-visible:ring-red-500',
          'dark:bg-red-700 dark:hover:bg-red-800',
        ],
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-9 px-4 text-sm',
        lg: 'h-11 px-6 text-base',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
  leftIcon?: LucideIcon;
  rightIcon?: LucideIcon;
}

// WORKING: Forward ref with asChild (Radix Slot) support
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      leftIcon: LeftIcon,
      rightIcon: RightIcon,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : 'button';
    const isDisabled = disabled || loading;

    const spinnerSize = size === 'lg' ? 'md' : 'sm';

    return (
      <Comp
        ref={ref}
        disabled={isDisabled}
        aria-disabled={isDisabled}
        aria-busy={loading}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      >
        {loading ? (
          <LoadingSpinner size={spinnerSize} />
        ) : (
          LeftIcon && <LeftIcon size={size === 'lg' ? 18 : 16} />
        )}
        {children}
        {!loading && RightIcon && <RightIcon size={size === 'lg' ? 18 : 16} />}
      </Comp>
    );
  }
);

Button.displayName = 'Button';

export { Button, buttonVariants };
