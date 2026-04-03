/**
 * Input — form text field with label, error/helper text, icon slots, and size variants.
 * WORKING: Forward ref, aria attributes, CVA-based styling.
 */

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

const inputVariants = cva(
  [
    'w-full rounded-md border bg-white font-normal text-gray-900 placeholder-gray-400',
    'transition-colors duration-150 outline-none',
    'focus:ring-2 focus:ring-offset-0',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-gray-50',
    'dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500',
    'dark:disabled:bg-gray-900',
  ],
  {
    variants: {
      inputVariant: {
        default: [
          'border-gray-300 focus:border-teal-500 focus:ring-teal-500/20',
          'dark:border-gray-600 dark:focus:border-teal-400',
        ],
        error: [
          'border-red-400 focus:border-red-500 focus:ring-red-500/20',
          'dark:border-red-500',
        ],
        success: [
          'border-green-400 focus:border-green-500 focus:ring-green-500/20',
          'dark:border-green-500',
        ],
      },
      size: {
        sm: 'h-8 px-2.5 text-xs',
        md: 'h-9 px-3 text-sm',
        lg: 'h-11 px-4 text-base',
      },
    },
    defaultVariants: {
      inputVariant: 'default',
      size: 'md',
    },
  }
);

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {
  label?: string;
  error?: string;
  helperText?: string;
  leftIcon?: LucideIcon;
  rightIcon?: LucideIcon;
}

// WORKING: Forward ref input with accessible label + error message linkage
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      inputVariant,
      size,
      label,
      error,
      helperText,
      leftIcon: LeftIcon,
      rightIcon: RightIcon,
      id,
      disabled,
      ...props
    },
    ref
  ) => {
    const generatedId = React.useId();
    const inputId = id ?? generatedId;
    const errorId = `${inputId}-error`;
    const helperId = `${inputId}-helper`;

    const resolvedVariant = error ? 'error' : inputVariant;
    const iconSize = size === 'lg' ? 18 : size === 'sm' ? 14 : 16;
    const hasLeftIcon = Boolean(LeftIcon);
    const hasRightIcon = Boolean(RightIcon);

    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {label}
          </label>
        )}

        <div className="relative flex items-center">
          {LeftIcon && (
            <span className="pointer-events-none absolute left-2.5 flex items-center text-gray-400 dark:text-gray-500">
              <LeftIcon size={iconSize} />
            </span>
          )}

          <input
            ref={ref}
            id={inputId}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            aria-describedby={
              [error ? errorId : null, helperText ? helperId : null]
                .filter(Boolean)
                .join(' ') || undefined
            }
            className={cn(
              inputVariants({ inputVariant: resolvedVariant, size }),
              hasLeftIcon && (size === 'lg' ? 'pl-10' : size === 'sm' ? 'pl-8' : 'pl-9'),
              hasRightIcon && (size === 'lg' ? 'pr-10' : size === 'sm' ? 'pr-8' : 'pr-9'),
              className
            )}
            {...props}
          />

          {RightIcon && (
            <span className="pointer-events-none absolute right-2.5 flex items-center text-gray-400 dark:text-gray-500">
              <RightIcon size={iconSize} />
            </span>
          )}
        </div>

        {error && (
          <p id={errorId} role="alert" className="text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {!error && helperText && (
          <p id={helperId} className="text-xs text-gray-500 dark:text-gray-400">
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

export { Input, inputVariants };
