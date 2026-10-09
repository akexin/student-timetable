'use strict';

/**
 * 通用工具库：标识符、日期时间、CSV 序列化、CRC32（供 xlsx 打包使用）。
 * 设计要点：所有日期按 UTC 毫秒数运算，杜绝服务器本地时区导致的偏移问题。
 */

const crypto = require('crypto');

const DAY = 86400000;

/* ------------------------------ 标识符 ------------------------------ */

function uid(prefix = 'c') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function randomToken(len = 16) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/* ------------------------------ 日期 ------------------------------ */

function parseDate(input) {
  if (input instanceof Date) return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(input).trim());
  if (!m) throw new Error(`非法日期 "${input}"，要求格式 YYYY-MM-DD`);
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new Error(`非法日期 "${input}"`);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) throw new Error(`非法日期 "${input}"`);
  return t;
}

function toDateStr(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * 取「业务时区」下的当天日期字符串。
 * 注意：服务器本地时区未必是东八区，直接 new Date() 取 UTC 日期会整体偏移一天，
 * 因此必须按配置的业务时区（默认 Asia/Shanghai）换算。
 */
function todayStr(timezone = 'Asia/Shanghai') {
  try {
    const s = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  } catch (e) { /* 回退到 UTC */ }
  return toDateStr(new Date());
}

function addDays(date, n) {
  return new Date(date.getTime() + n * DAY);
}

function diffDays(a, b) {
  return Math.round((a.getTime() - b.getTime()) / DAY);
}

/** 取该日期所在周的周一（ISO 周，周一为一周第一日） */
function weekStartMonday(date) {
  const dow = date.getUTCDay(); // 0=周日
  const delta = dow === 0 ? -6 : 1 - dow;
  return addDays(date, delta);
}

const DOW_CN = ['日', '一', '二', '三', '四', '五', '六'];
const DOW_ICS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/* ------------------------------ 时间 ------------------------------ */

function parseTime(input) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(input).trim());
  if (!m) throw new Error(`非法时间 "${input}"，要求格式 HH:mm 或 HH:mm:ss`);
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) throw new Error(`非法时间 "${input}"`);
  return h * 60 + mi;
}

function fmtTime(minutes) {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/* ------------------------------ CSV ------------------------------ */

/**
 * RFC4180 CSV 解析：支持引号包裹、字段内逗号/换行、"" 转义。
 * @param {string} text
 * @returns {Array<Array<string>>}
 */
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
    } else if (ch === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** @param {Array<Array<any>>} rows */
function toCSV(rows) {
  return '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/* ------------------------------ CRC32（ZIP 需要） ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------ 杂项 ------------------------------ */

function clone(o) {
  return o === undefined ? o : JSON.parse(JSON.stringify(o));
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function deepMerge(base, patch) {
  const out = clone(base || {});
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else out[k] = clone(v);
  }
  return out;
}

function httpGet(url) {
  return Promise.resolve().then(() => fetch(url, { redirect: 'follow' })).then(async (res) => {
    if (!res.ok) throw new Error(`抓取 ${url} 失败：HTTP ${res.status}`);
    return await res.text();
  });
}

module.exports = {
  DAY, DOW_CN, DOW_ICS,
  uid, randomToken, pad2,
  parseDate, toDateStr, todayStr, addDays, diffDays, weekStartMonday,
  parseTime, fmtTime,
  parseCSV, toCSV, csvCell,
  crc32,
  clone, pick, deepMerge, httpGet,
};
