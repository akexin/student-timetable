'use strict';

/**
 * 零依赖 xlsx（OOXML SpreadsheetML）写入器。
 *
 * 实现要点：
 *  1. xlsx 本质是一个 ZIP 容器，此处采用 STORE（不压缩）方式手工组包，
 *     自行实现 CRC32，避免引入第三方依赖；
 *  2. 单元格使用 inlineStr（内联字符串），省去 sharedStrings.xml；
 *  3. 字符串统一 XML 转义并剔除非法控制字符，保证 Excel / WPS / LibreOffice 均可打开。
 */

const { crc32 } = require('./util');

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/** 0-based 列号 → A1 风格列标 */
function colName(n) {
  let s = '';
  n += 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const CONTENT_TYPES = (sheetCount) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${Array.from({ length: sheetCount }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font><font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F1"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function workbookXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`;
}

function workbookRels(sheetCount) {
  const rels = Array.from({ length: sheetCount }, (_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`);
  rels.push(`<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
}

function sheetXml(sheet) {
  const cols = (sheet.columns || []).map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('');
  const rows = (sheet.rows || []).map((row, ri) => {
    const cells = row.map((v, ci) => {
      const ref = `${colName(ci)}${ri + 1}`;
      if (v === null || v === undefined || v === '') {
        return `<c r="${ref}" s="${ri === 0 ? 1 : 2}"/>`;
      }
      if (typeof v === 'number' && Number.isFinite(v)) {
        return `<c r="${ref}" s="${ri === 0 ? 1 : 2}"><v>${v}</v></c>`;
      }
      return `<c r="${ref}" s="${ri === 0 ? 1 : 2}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
    }).join('');
    const ht = ri === 0 ? ' ht="24" customHeight="1"' : '';
    return `<row r="${ri + 1}"${ht}>${cells}</row>`;
  }).join('');
  const dim = `A1:${colName(Math.max(0, ((sheet.rows && sheet.rows[0]) || []).length - 1))}${(sheet.rows || []).length || 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="${dim}"/>
<sheetViews><sheetView workbookViewId="0">${sheet.freezeHeader ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>' : ''}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/>
${cols ? `<cols>${cols}</cols>` : ''}
<sheetData>${rows}</sheetData>
</worksheet>`;
}

/** 手工打包 ZIP（STORE 模式） */
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  let cdSize = 0;
  const now = new Date();
  const dosTime = ((now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | Math.floor(now.getUTCSeconds() / 2)) & 0xffff;
  const dosDate = (((now.getUTCFullYear() - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate()) & 0xffff;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const dataBuf = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(dataBuf);
    const size = dataBuf.length;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);   // UTF-8 filename
    lh.writeUInt16LE(0, 8);        // STORE
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, dataBuf);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    cdSize += cd.length + nameBuf.length;
    offset += lh.length + nameBuf.length + size;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...central, eocd]);
}

/**
 * 生成 xlsx。
 * @param {Array<{name:string,columns?:Array<{header:string,width?:number}>,rows:Array<Array<any>>,freezeHeader?:boolean}>} sheets
 * @returns {Buffer}
 */
function buildXlsx(sheets) {
  const list = sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }];
  const files = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES(list.length) },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'xl/workbook.xml', data: workbookXml(list) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels(list.length) },
    { name: 'xl/styles.xml', data: STYLES },
  ];
  list.forEach((s, i) => {
    const rows = [];
    if (s.columns) rows.push(s.columns.map(c => c.header));
    if (s.rows) rows.push(...s.rows);
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml({ ...s, rows }) });
  });
  return zipStore(files);
}

module.exports = { buildXlsx, xmlEscape, colName, zipStore };
