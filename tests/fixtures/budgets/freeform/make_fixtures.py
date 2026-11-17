"""
Round 7 fixtures for the free-form budget import (MCP budget tools PR 2): made in LibreOffice 24.2 over UNO the way a
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
import os, subprocess, sys, time, glob
import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.lang import Locale

def pv(n, v):
    p = PropertyValue(); p.Name = n; p.Value = v; return p

class Office:
    def __init__(self, profile, port=2203):
        self.proc = subprocess.Popen(['soffice', '--headless', '--invisible', '--norestore', f'-env:UserInstallation=file://{profile}',
                                      f'--accept=socket,host=localhost,port={port};urp;'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
        for _ in range(90):
            try:
                self.ctx = resolver.resolve(f'uno:socket,host=localhost,port={port};urp;StarOffice.ComponentContext'); break
            except Exception:
                time.sleep(1)
        self.desktop = self.ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', self.ctx)
    def new(self, locale=('en', 'ZA')):
        doc = self.desktop.loadComponentFromURL('private:factory/scalc', '_blank', 0, (pv('Hidden', True),))
        doc.CharLocale = Locale(locale[0], locale[1], '')
        return doc
    def close(self):
        try: self.desktop.terminate()
        except Exception: pass
        self.proc.wait(timeout=60)

def fmt(doc, code, locale=('en', 'US')):
    loc = Locale(locale[0], locale[1], '')
    k = doc.NumberFormats.queryKey(code, loc, False)
    return k if k != -1 else doc.NumberFormats.addNew(code, loc)

def save(doc, path):
    doc.storeToURL(uno.systemPathToFileUrl(path), (pv('FilterName', 'Calc MS Excel 2007 XML'),))
    doc.close(True)

def typer(o, doc):
    """Type text into a cell the way a user does (the input line: number / date recognition and autoformat)."""
    disp = o.ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.DispatchHelper', o.ctx)
    frame = doc.CurrentController.Frame
    def type_(sheet, ref, text):
        doc.CurrentController.setActiveSheet(sheet)
        doc.CurrentController.select(sheet.getCellRangeByName(ref))
        disp.executeDispatch(frame, '.uno:EnterString', '', 0, (pv('StringName', text),))
    return type_

def set_locale(o, tag):
    """Tools > Options > Language Settings > Locale setting (the input / display locale), as a user sets it."""
    cp = o.ctx.ServiceManager.createInstanceWithContext('com.sun.star.configuration.ConfigurationProvider', o.ctx)
    ua = cp.createInstanceWithArguments('com.sun.star.configuration.ConfigurationUpdateAccess', (pv('nodepath', '/org.openoffice.Setup/L10N'),))
    ua.setPropertyValue('ooSetupSystemLocale', tag)
    ua.commitChanges()

NUMBER = uno.getConstantByName('com.sun.star.util.NumberFormat.NUMBER')
CURRENCY = uno.getConstantByName('com.sun.star.util.NumberFormat.CURRENCY')
ZA, US = Locale('en', 'ZA', ''), Locale('en', 'US', '')
MONTHS = ['Mar 2026', 'Apr 2026', 'May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026', 'Oct 2026', 'Nov 2026', 'Dec 2026', 'Jan 2027', 'Feb 2027']
COLS = 'ABCDEFGHIJKLMNOP'

class Book:
    def __init__(self, o, locale):
        self.o, self.loc = o, locale
        self.doc = o.new((locale.Language, locale.Country))
        self.t = typer(o, self.doc)
        self.sheet = self.doc.Sheets.getByIndex(0)
    def dialog(self, decimals, thousands=False, red=False, kind=NUMBER, loc=None):
        nf, loc = self.doc.NumberFormats, loc or self.loc
        code = nf.generateFormat(nf.getStandardFormat(kind, loc), loc, thousands, red, decimals, 1)
        k = nf.queryKey(code, loc, False)
        return k if k != -1 else nf.addNew(code, loc)
    def custom(self, code, loc=None):
        nf, loc = self.doc.NumberFormats, loc or self.loc
        k = nf.queryKey(code, loc, False)
        return k if k != -1 else nf.addNew(code, loc)
    def cell(self, ref, sheet=None):
        return (sheet or self.sheet).getCellRangeByName(ref)
    def type(self, ref, text, sheet=None):
        self.t(sheet or self.sheet, ref, text)
    def fmt(self, ref, key, sheet=None):
        self.cell(ref, sheet).NumberFormat = key
    def formula(self, ref, f, sheet=None):
        self.cell(ref, sheet).setFormula(f)
    def header(self, row, first, sheet=None, months=MONTHS):
        for i, h in enumerate(first + months):
            self.type(f'{COLS[i]}{row}', h, sheet)
    def save(self, name, active=None):
        if active is not None:
            self.doc.CurrentController.setActiveSheet(active)
        self.doc.CurrentController.select(self.cell('A1', active))
        save(self.doc, f'{OUT}/{name}.xlsx')

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

FIXTURES = {  # name: (locale, builder)
    'b1-codes-en-us': (US, lambda b: b1_codes(b, '.')), 'b1-codes-en-za': (ZA, lambda b: b1_codes(b, ',')),
    'b1-dimension-en-za': (ZA, lambda b: b1_dimension(b, ',')),
    'signs-en-us': (US, signs), 'signs-en-za': (ZA, signs), 'locale-tags-en-us': (US, locale_tags), 'locale-tags-en-za': (ZA, locale_tags),
    'rand-nosep-en-za': (ZA, rand_nosep), 'rounding-en-za': (ZA, rounding), 'total-name-en-za': (ZA, total_name),
    'total-name-refused-en-za': (ZA, total_name_refused), 'title-merge-en-za': (ZA, title_merge), 'merge-header-en-za': (ZA, merge_header),
    'merge-body-en-za': (ZA, merge_body), 'active-sheet-en-za': (ZA, active_sheet), 'mar-26-en-za': (ZA, mar26),
    'narrow-column-en-za': (ZA, narrow), 'short-row-en-za': (ZA, short_row), 'colours-en-us': (US, colours),
}


def main():
    global OUT
    profile, tag, out = sys.argv[1], sys.argv[2], sys.argv[3]
    OUT = out
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
            b = Book(o, loc)
            b.save(name, build(b))
            print('wrote', name)
    finally:
        o.close()

if __name__ == '__main__':
    main()
