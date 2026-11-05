// Adversarial repros for PR #1149: fold arithmetic, names with markup in the PDF HTML and the DOCX.
import { describe, expect, it } from 'vitest';
import { Document, Packer } from 'docx';
import JSZip from 'jszip';
import { ageingBlocks, AGEING_TOP } from '@/modules/accounting/services/afs/managementPackReportSections';
import { renderSectionContent } from '@/modules/accounting/services/afs/afsHtmlTableRenderer';
import { renderNoteTable } from '@/modules/accounting/services/afs/docxTableRenderer';
import { calculateAgingBuckets } from '@/modules/accounting/utils/aging';
import type { AgeingData } from '@/modules/accounting/services/afs/managementPackReportSections';
import type { AfsSection, NoteContentTable } from '@/modules/accounting/services/afs/afsTypes';

const cents = (s: string) => Math.round(Number(s.replace('\u2212', '-').replace(/[^0-9.-]/g, '')) * 100);

function report(names: string[], amounts: number[]): AgeingData {
  const invoices = names.map((n, i) => ({
    id: `i${i}`, entityId: `e${i % 30}`, entityName: n, dueDate: ['2027-02-20', '2027-01-10', '2026-12-01', '2026-10-01'][i % 4]!,
    totalAmount: amounts[i]!, amountPaid: 0, balance: amounts[i]!, disputedAmount: i % 7 === 0 ? Math.round(amounts[i]! * 100 / 3) / 100 : 0,
  }));
  // The adapted shape: the services' rows, as the screens get them (the pack no longer reads a report with its own totals).
  return { asAt: '2027-02-28', buckets: calculateAgingBuckets(invoices, new Date('2027-02-28')), unapplied: 0, creditOnly: [] };
}

describe('#1149 fold arithmetic', () => {
  it('top 10 + folded rest = Total, in every column, over 200 random books', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (let k = 0; k < 200; k++) {
      const n = 12 + Math.floor(rnd() * 80);
      const amounts = Array.from({ length: n }, () => Math.round(rnd() * 1e7) / 100 + 0.01);
      const t = ageingBlocks(report(Array.from({ length: n }, (_, i) => `C${i % 30}`), amounts), 'ar')[0] as NoteContentTable;
      expect(t.rows.length).toBe(AGEING_TOP + 2);
      for (let col = 1; col < t.headers.length; col++) {
        const body = t.rows.slice(0, -1).reduce((s, r) => s + cents(r[col]!), 0);
        expect(body, `book ${k} col ${t.headers[col]}`).toBe(cents(t.rows.at(-1)![col]!));
      }
    }
  });
});

describe('#1149 names with markup', () => {
  const evil = '<img src=x onerror=alert(1)></td><script>x()</script> & Co\u000B';
  const table = ageingBlocks(report([evil, 'Plain'], [100, 50]), 'ap')[0] as NoteContentTable;

  it('the PDF HTML escapes the name', () => {
    const html = renderSectionContent({ id: 's', content: { title: 'Creditors Ageing', blocks: [table] } } as unknown as AfsSection);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
  });

  it('the DOCX packs and its document.xml carries no XML-illegal character', async () => {
    const buf = await Packer.toBuffer(new Document({ sections: [{ children: [renderNoteTable(table)] }] }));
    const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string');
    expect(xml).toContain('&lt;img');
    // eslint-disable-next-line no-control-regex
    expect(xml.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g)).toBeNull();
  });
});
