"""
LibreOffice over UNO for the free-form budget fixtures (`make_fixtures.py`): start soffice headless on a profile,
set its locale setting, open a Calc document, type into cells through the input line, make formats the way the
Format Cells dialog does, and save as xlsx.
"""
import subprocess, time
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
    def __init__(self, o, locale, out):
        self.o, self.loc, self.out = o, locale, out
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
        save(self.doc, f'{self.out}/{name}.xlsx')
