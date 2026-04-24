import { describe, it, expect } from 'vitest';
import { findCrossFileDuplicates } from '@/lib/bulkUpload/crossFileDedup';

describe('findCrossFileDuplicates', () => {
  it('returns empty when no overlap', () => {
    const result = findCrossFileDuplicates([
      { filename: 'jan.pdf', rowHashes: ['a', 'b', 'c'] },
      { filename: 'feb.pdf', rowHashes: ['d', 'e', 'f'] },
    ]);
    expect(result.size).toBe(0);
  });

  it('flags later file when hashes overlap with an earlier file', () => {
    const result = findCrossFileDuplicates([
      { filename: 'q1.pdf', rowHashes: ['jan-1', 'jan-2', 'feb-1', 'feb-2', 'mar-1'] },
      { filename: 'feb-only.pdf', rowHashes: ['feb-1', 'feb-2', 'feb-3'] },
    ]);
    const hit = result.get('feb-only.pdf');
    expect(hit).toBeDefined();
    expect(hit?.duplicateOf).toBe('q1.pdf');
    expect(hit?.duplicateRows).toBe(2);
    expect(hit?.totalRows).toBe(3);
  });

  it('does not flag the earlier file', () => {
    const result = findCrossFileDuplicates([
      { filename: 'jan.pdf', rowHashes: ['j1', 'j2'] },
      { filename: 'jan-and-feb.pdf', rowHashes: ['j1', 'j2', 'f1'] },
    ]);
    expect(result.has('jan.pdf')).toBe(false);
    expect(result.has('jan-and-feb.pdf')).toBe(true);
  });

  it('attributes duplicates to the file with the largest overlap when multiple owners exist', () => {
    const result = findCrossFileDuplicates([
      { filename: 'a.pdf', rowHashes: ['x'] },
      { filename: 'b.pdf', rowHashes: ['y', 'z'] },
      { filename: 'c.pdf', rowHashes: ['x', 'y', 'z'] },
    ]);
    const hit = result.get('c.pdf');
    expect(hit?.duplicateOf).toBe('b.pdf');
    expect(hit?.duplicateRows).toBe(2);
  });

  it('skips files with empty hash list', () => {
    const result = findCrossFileDuplicates([
      { filename: 'a.pdf', rowHashes: [] },
      { filename: 'b.pdf', rowHashes: [] },
    ]);
    expect(result.size).toBe(0);
  });
});
