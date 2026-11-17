"""
Fixtures for the free-form budget import (rounds 7 and 8) (MCP budget tools PR 2): made in LibreOffice 24.2 over UNO the way a
user makes them. Text is TYPED through the input line (.uno:EnterString: the locale's number and date recognition and
autoformat), formats come from the Format Cells dialog's own generator (generateFormat: decimals, thousands separator,
negative in red, Language) or are typed as a custom code, formulas are entered, merges / widths / heights / the open
sheet are set as the UI sets them, and the file is saved as Excel 2007-365 xlsx. No XML is edited.

  python3 make_fixtures.py <profile dir> en-ZA|en-US <out dir> [fixture ...]   make the fixtures of that locale
  python3 make_fixtures.py <profile dir> en-ZA|en-US <out dir> --csv <csv dir>  LibreOffice opens each one and saves
      its open sheet as CSV with "save cell contents as shown" (what a user sees; the evidence doc's table)

The profile's Tools > Options > Locale setting is set to the locale given (one profile per locale). Needs soffice and
its python3-uno on PATH. The files are committed; re-run only to change them.
"""
import os, sys, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # lo_uno beside this file (also under python3 -I)
import uno
from com.sun.star.lang import Locale
from lo_uno import Office, Book, pv, set_locale, NUMBER, CURRENCY, ZA, US, MONTHS, COLS

def b1_codes(b, dec):
    """B1: numeric account codes and how they are formatted. Mar holds 10 on every row."""
    b.header(1, ['Code', 'Name'])
    rows = [  # (code typed, format key or None = left General, name)
        (f'4000{dec}10', b.dialog(2), 'code 4000.1 shown with 2 decimals'),
        (f'4000{dec}1', b.dialog(0), 'code 4000.1 shown as 4000'),
        ('400', b.custom('0000', US), 'code 400 shown as 0400'),
        ('6000', None, 'code 6000, General'),
        (f'4000{dec}5', None, 'code 4000.5, General'),
        ('7100', 'text-after', 'code 7100 typed, then the column formatted as Text'),
        ('4000', b.dialog(0, thousands=True), 'code 4000 shown as 4,000'),
    ]
    for i, (code, key, name) in enumerate(rows, start=2):
        b.type(f'A{i}', code)
        if key == 'text-after': b.fmt(f'A{i}', b.custom('@'))
        elif key is not None: b.fmt(f'A{i}', key)
        b.type(f'B{i}', name); b.type(f'C{i}', '10')

def b1_dimension(b, dec):
    b.header(1, ['Code', 'CC1'])
    b.type('A2', '6000'); b.type('B2', '10'); b.fmt('B2', b.dialog(2)); b.type('C2', '10')
    b.type('A3', '4000'); b.type('B3', '10'); b.type('C3', '20')
    b.type('A4', '7100'); b.type('B4', '10'); b.fmt('B4', b.custom('@')); b.type('C4', '30')

def signs(b):
    """Items 1, 2: -5 in each negative-section spelling, one per month column of the 6000 row."""
    b.header(1, ['Code', 'Name'])
    b.type('A2', '6000'); b.type('B2', 'Rent')
    keys = [b.dialog(2, thousands=True, red=True), b.dialog(0, red=True), b.custom('#,##0.00_);\\(#,##0.00\\)', US),
            b.custom('#,##0.00_);[Red]\\(#,##0.00\\)', US), b.custom('#,##0_);[Red]\\(#,##0\\)', US), b.custom('#,##0.00_);(#,##0.00)', US),
            b.dialog(2, red=True)]
    for i, k in enumerate(keys):
        ref = f'{COLS[2 + i]}2'; b.type(ref, '-5'); b.fmt(ref, k)
    b.type('A3', '4000'); b.type('B3', 'Sales')
    for i, k in enumerate(keys):
        ref = f'{COLS[2 + i]}3'; b.type(ref, '5'); b.fmt(ref, k)

def locale_tags(b):
    """Item 3: formats whose Language is set in the dialog (LibreOffice then writes a [$-XXXX] tag)."""
    b.header(1, ['Code', 'Name'])
    b.type('A2', '6000'); b.type('B2', 'Rent')
    langs = [Locale('en', 'ZA', ''), Locale('en', 'GB', ''), Locale('af', 'ZA', ''), Locale('de', 'DE', ''), Locale('en', 'ZA', '')]
    keys = [b.dialog(2, loc=langs[0]), b.dialog(2, thousands=True, loc=langs[1]), b.dialog(2, loc=langs[2]), b.dialog(2, red=True, loc=langs[3]),
            b.doc.NumberFormats.getStandardFormat(NUMBER, langs[4]), b.custom('@', langs[0])]
    for i, k in enumerate(keys):
        ref = f'{COLS[2 + i]}2'; b.type(ref, '12.5' if b.loc.Country == 'US' else '12,5'); b.fmt(ref, k)

def rand_nosep(b):
    """Item 4: the rand currency format without a thousands separator (the dialog, and typed codes)."""
    b.header(1, ['Code', 'Name'])
    b.type('A2', '6000'); b.type('B2', 'Rent')
    keys = [b.dialog(2, kind=CURRENCY), b.dialog(2, red=True, kind=CURRENCY), b.dialog(0, kind=CURRENCY), b.dialog(0, red=True, kind=CURRENCY),
            b.custom('"R "0.00', US), b.custom('[$R-1C09]\\ 0.00', US), b.custom('"R"0.00', US), b.custom('"R "0', US)]
    vals = ['-1234,5', '-1234,5', '-1234', '-1234', '1234,5', '-1234,5', '1234,5', '1234']
    for i, (k, v) in enumerate(zip(keys, vals)):
        ref = f'{COLS[2 + i]}2'; b.type(ref, v); b.fmt(ref, k)

def rounding(b):
    """Item 5: unrounded values (formulas) under 2-, 0-, 1- and 3-decimal formats and General."""
    b.header(1, ['Code', 'Name'])
    b.type('A2', '6000'); b.type('B2', 'Rent (2 decimals: imported as shown)')
    cur2 = b.dialog(2, kind=CURRENCY)
    for ref, f, k in [('C2', '=100000/12', b.dialog(2, thousands=True)), ('D2', '=-100000/12', b.dialog(2, thousands=True, red=True)),
                      ('E2', '=12345.67/2', cur2), ('F2', '=1.005', b.dialog(2)), ('G2', '=2.675', b.dialog(2)), ('H2', '=-2.675', b.dialog(2)),
                      ('I2', '=1234.5', b.dialog(2)), ('J2', '=0.125', b.custom('_-"R"* #,##0.00_-;\\-"R"* #,##0.00_-;_-"R"* "-"??_-;_-@_-', US))]:
        b.formula(ref, f); b.fmt(ref, k)
    b.type('A3', '4000'); b.type('B3', 'Sales (refused: General, 3 decimals, 0 decimals, 1 decimal)')
    for ref, f, k in [('C3', '=1/3', None), ('D3', '=1/3', b.dialog(3)), ('E3', '=1000/12', b.dialog(0, thousands=True)), ('F3', '=1000/12', b.dialog(1))]:
        b.formula(ref, f)
        if k is not None: b.fmt(ref, k)

def total_name(b):
    """Item 6: total rows with the word in the Name column and no code."""
    b.header(1, ['Code', 'Name'])
    b.type('A2', '6000'); b.type('B2', 'Rent'); b.type('C2', '100')
    b.type('A3', '4000'); b.type('B3', 'Sales'); b.type('C3', '200')
    b.type('B4', 'Total'); b.formula('C4', '=SUM(C2:C3)')
    b.type('B5', 'Grand total'); b.formula('C5', '=C4')

def total_name_refused(b):
    b.header(1, ['Code', 'Name'])
    b.type('A2', '6000'); b.type('B2', 'Rent'); b.type('C2', '100')
    b.type('B3', 'Rent again'); b.type('C3', '5')

def title_merge(b):
    """Item 7: a title merged across the top, above the header."""
    b.type('A1', 'Budget FY2027'); b.sheet.getCellRangeByName('A1:N1').merge(True)
    b.header(3, ['Code', 'Name'])
    b.type('A4', '6000'); b.type('B4', 'Rent'); b.type('C4', '100')

def merge_header(b):
    """The last month's header merged with the empty cell to its right (to widen it)."""
    b.header(1, ['Code', 'Name'])
    b.type('A2', '6000'); b.type('B2', 'Rent'); b.type('C2', '100')
    b.sheet.getCellRangeByName('N1:O1').merge(True)

def merge_body(b):
    b.header(1, ['Code', 'Name'])
    b.type('A2', '6000'); b.type('B2', 'Rent'); b.type('C2', '100'); b.sheet.getCellRangeByName('C2:D2').merge(True)

def active_sheet(b):
    """Item 9: the workbook opens on its second sheet."""
    sheets = b.doc.Sheets
    sheets.getByIndex(0).Name = 'Notes'
    b.type('A1', 'Read me: the budget is on the next sheet', sheets.getByIndex(0))
    sheets.insertNewByName('Budget', 1)
    s = sheets.getByName('Budget')
    b.header(1, ['Code', 'Name'], s)
    b.type('A2', '6000', s); b.type('B2', 'Rent', s); b.type('C2', '100', s)
    return s

def mar26(b):
    """Item 10: two-digit-year month headers typed in en-ZA (read as 26 March 2026, 27 January 2026, ...)."""
    b.header(1, ['Code', 'Name'], months=[m[:3] + '-' + m[-2:] for m in MONTHS])
    b.type('A2', '6000'); b.type('B2', 'Rent'); b.type('C2', '100')

def narrow(b):
    """Low: a column 1.5 mm wide (under one character), and (narrow_row) a row 2pt high."""
    b.header(1, ['Code', 'Name'])
    b.type('A2', '6000'); b.type('B2', 'Rent'); b.type('C2', '100'); b.type('D2', '200')
    b.sheet.Columns.getByIndex(3).Width = 150  # 1.5 mm, under one character

def short_row(b):
    b.header(1, ['Code', 'Name'])
    b.type('A2', '6000'); b.type('B2', 'Rent'); b.type('C2', '100')
    b.type('A3', '4000'); b.type('B3', 'Sales'); b.type('C3', '200')
    b.sheet.Rows.getByIndex(2).Height = 70  # 0.7 mm, 2pt

def colours(b):
    b.header(1, ['Code', 'Name'])
    b.type('A2', '6000'); b.type('B2', 'Rent')
    for ref, code in [('C2', '#,##0.00;[BLACK]-#,##0.00'), ('D2', '#,##0.00;[BLUE]-#,##0.00'), ('E2', '#,##0.00;[WHITE]-#,##0.00'), ('F2', '[WHITE]#,##0.00')]:
        b.type(ref, '-5'); b.fmt(ref, b.custom(code, US))

def cond_style(b, name, number=None, white=False, back=None, border=False):
    """Round 8: a cell style for a conditional format, as Format > Conditional > Condition > New Style makes it."""
    styles = b.doc.StyleFamilies.getByName('CellStyles')
    st = b.doc.createInstance('com.sun.star.style.CellStyle')
    styles.insertByName(name, st)
    if number is not None: st.NumberFormat = b.custom(number, US)
    if white: st.CharColor = 0xFFFFFF
    if back is not None: st.CellBackColor = back
    if border:
        line = uno.createUnoStruct('com.sun.star.table.BorderLine2'); line.OuterLineWidth = 50; st.TopBorder = line
    return name

def cond(b, ref, style, op='GREATER', formula='0'):
    """Format > Conditional > Condition: "cell value is" op formula, applying style, on ref."""
    rng = b.sheet.getCellRangeByName(ref)
    cf = rng.ConditionalFormat
    cf.addNew((pv('Operator', uno.Enum('com.sun.star.sheet.ConditionOperator', op)), pv('Formula1', formula), pv('StyleName', style)))
    rng.ConditionalFormat = cf

def cond_sheet(b, **style):
    b.header(1, ['Code', 'Name'])
    b.type('A2', '6000'); b.type('B2', 'Rent'); b.type('C2', '1500'); b.type('D2', '250')
    cond(b, 'C2:N2', cond_style(b, 'Round8', **style))

def cond_title(b):
    """A white-text condition on the title above the header only: not on any amount."""
    b.type('A1', 'Budget FY2027')
    b.header(2, ['Code', 'Name'])
    b.type('A3', '6000'); b.type('B3', 'Rent'); b.type('C3', '1500')
    cond(b, 'A1', cond_style(b, 'Round8', white=True), op='NOT_EQUAL', formula='""')

FIXTURES = {  # name: (locale, builder)
    'b1-codes-en-us': (US, lambda b: b1_codes(b, '.')), 'b1-codes-en-za': (ZA, lambda b: b1_codes(b, ',')),
    'b1-dimension-en-za': (ZA, lambda b: b1_dimension(b, ',')),
    'signs-en-us': (US, signs), 'signs-en-za': (ZA, signs), 'locale-tags-en-us': (US, locale_tags), 'locale-tags-en-za': (ZA, locale_tags),
    'rand-nosep-en-za': (ZA, rand_nosep), 'rounding-en-za': (ZA, rounding), 'total-name-en-za': (ZA, total_name),
    'total-name-refused-en-za': (ZA, total_name_refused), 'title-merge-en-za': (ZA, title_merge), 'merge-header-en-za': (ZA, merge_header),
    'merge-body-en-za': (ZA, merge_body), 'active-sheet-en-za': (ZA, active_sheet), 'mar-26-en-za': (ZA, mar26),
    'narrow-column-en-za': (ZA, narrow), 'short-row-en-za': (ZA, short_row), 'colours-en-us': (US, colours),
    # Round 8: conditional formats whose style changes the number format, hides the value, or colours it white.
    'cond-thousands-en-za': (ZA, lambda b: cond_sheet(b, number='#,##0,')), 'cond-hidden-en-za': (ZA, lambda b: cond_sheet(b, number=';;;')),
    'cond-white-en-za': (ZA, lambda b: cond_sheet(b, white=True)), 'cond-fill-en-za': (ZA, lambda b: cond_sheet(b, back=0xFFFF00)),
    'cond-border-en-za': (ZA, lambda b: cond_sheet(b, border=True)), 'cond-title-en-za': (ZA, cond_title),
}


def main():
    profile, tag, out = sys.argv[1], sys.argv[2], sys.argv[3]
    rest = sys.argv[4:]
    port = 2210 if tag == 'en-ZA' else 2211
    o = Office(profile, port); set_locale(o, tag); o.close()  # the locale setting is read at start: restart
    o = Office(profile, port)
    try:
        suffix = tag.lower()
        if rest[:1] == ['--csv']:
            for f in sorted(glob.glob(f'{out}/*-{suffix}.xlsx')):
                doc = o.desktop.loadComponentFromURL(uno.systemPathToFileUrl(f), '_blank', 0, (pv('Hidden', True),))
                n = doc.Sheets.getElementNames().index(doc.CurrentController.ActiveSheet.Name) + 1
                # comma, quote, UTF-8, line 1, -, language, quoted as text, detect special numbers, AS SHOWN, no formulas, keep spaces, sheet n
                opts = f'44,34,76,1,,0,false,true,true,false,false,{n}'
                doc.storeToURL(uno.systemPathToFileUrl(f'{rest[1]}/{os.path.basename(f)[:-5]}.csv'), (pv('FilterName', 'Text - txt - csv (StarCalc)'), pv('FilterOptions', opts)))
                doc.close(True)
            return
        for name, (loc, build) in FIXTURES.items():
            if (rest and name not in rest) or not name.endswith(suffix): continue
            b = Book(o, loc, out)
            b.save(name, build(b))
            print('wrote', name)
    finally:
        o.close()

if __name__ == '__main__':
    main()
