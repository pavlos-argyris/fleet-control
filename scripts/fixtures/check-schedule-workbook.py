import sys,zipfile,xml.etree.ElementTree as E
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(sys.argv[1]) as book:
    assert book.testzip() is None
    for name in book.namelist():
        assert not name.startswith('/') and '..' not in name.split('/')
        E.fromstring(book.read(name))
    wb=E.fromstring(book.read('xl/workbook.xml'))
    sheets=wb.findall('s:sheets/s:sheet',ns)
    assert [s.get('name') for s in sheets]==['Πρόγραμμα 2026-11-02','Πρόγραμμα 2026-11-09','Οδηγίες','Επιλογές']
    assert sheets[-1].get('state')=='hidden'
    names={n.get('name'):n.text for n in wb.findall('s:definedNames/s:definedName',ns)}
    assert names=={'ShiftChoices':"'Επιλογές'!$A$2:$A$3",'VehicleChoices':"'Επιλογές'!$B$2:$B$5"}
    for number in [1,2]:
        sheet=E.fromstring(book.read(f'xl/worksheets/sheet{number}.xml'))
        rows=sheet.findall('s:sheetData/s:row',ns)
        assert len(rows)==3 and all(len(r.findall('s:c',ns))==16 for r in rows)
        assert sheet.find('s:cols/s:col[@min="2"]',ns).get('hidden')=='1'
        validations=sheet.findall('s:dataValidations/s:dataValidation',ns)
        assert len(validations)==14 and all(v.get('type')=='list' for v in validations)
        assert {v.find('s:formula1',ns).text for v in validations}=={'ShiftChoices','VehicleChoices'}
        assert sheet.find('s:autoFilter',ns).get('ref')=='A1:P3'
        assert sheet.find('s:sheetViews/s:sheetView/s:pane',ns).get('state')=='frozen'
    first=E.fromstring(book.read('xl/worksheets/sheet1.xml'))
    values={c.get('r'):''.join(c.itertext()) for c in first.findall('.//s:c',ns)}
    assert values['A3']=='Μαρία & Σία <δοκιμή>' and values['C2']=='08:00 - 16:00'
    assert values['D2']=='ΒΤΟ 756' and values['D3']=='Ιδιόκτητο μηχανάκι'
    assert not first.findall('.//s:f',ns),'User text never becomes a spreadsheet formula'
print('PASS independent ZIP/XML validation: both program weeks, every staff/day cell, hidden stable IDs, native dropdowns, filters, panes and literal user data.')
