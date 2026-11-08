/** UXB (wave 5): the kit Select's densest size, `xs`, is 24 px (the WCAG 2.5.8 minimum target). */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { Select } from '@/components/ui/Select';

const options = [{ value: 'a', label: 'A' }];

describe('Select size', () => {
  it.each([['xs', 'min-h-[24px]'], ['sm', 'min-h-[32px]'], ['md', 'min-h-[40px]']] as const)('%s trigger is %s', (size, cls) => {
    render(<Select label="L" size={size} options={options} value={null} onChange={() => undefined} />);
    expect(screen.getByRole('combobox').className).toContain(cls);
  });
});
