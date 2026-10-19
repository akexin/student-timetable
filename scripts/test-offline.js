#!/usr/bin/env node
'use strict';

/**
 * 在 Node 里模拟浏览器环境，实际执行 offline/runtime.js + bundle.js，
 * 验证「离线模式」的完整链路：路由、鉴权、存储、ICS/XLSX 二进制生成。
 * 仅用于开发自检，不参与打包。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const runtimeCode = fs.readFileSync(path.join(ROOT, 'public/offline/runtime.js'), 'utf8');
const bundleCode = fs.readFileSync(path.join(ROOT, 'public/offline/bundle.js'), 'utf8');

const localStorage = {
  _data: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
  setItem(k, v) { this._data[k] = String(v); },
  removeItem(k) { delete this._data[k]; },
};

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  queueMicrotask,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  Uint16Array,
  Uint32Array,
  Int32Array,
  DataView,
  ArrayBuffer,
  Blob,
  URL,
  URLSearchParams,
  Map,
  Set,
  Promise,
  JSON,
  Math,
  Date,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  TypeError,
  RangeError,
  RegExp,
  Symbol,
  parseInt,
  parseFloat,
  isNaN,
  encodeURIComponent,
  decodeURIComponent,
  StructuredClone: globalThis.structuredClone,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  crypto: globalThis.crypto,
  localStorage,
  location: { href: 'https://appassets.androidplatform.net/index.html', host: 'appassets.androidplatform.net' },
  document: {
    visibilityState: 'visible',
    createElement: () => ({}),
    addEventListener: () => {},
    body: { appendChild: () => {} },
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};

sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(runtimeCode, sandbox);
vm.runInContext(bundleCode, sandbox);

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
}

(async () => {
  // 等待 boot 完成（IndexedDB 缺失会被降级为纯内存，boot 仍会继续）
  for (let i = 0; i < 100; i++) {
    if (sandbox.__TT_READY__) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  check('boot 完成（__TT_READY__）', sandbox.__TT_READY__);

  const H = { 'X-API-Key': 'local', 'Content-Type': 'application/json' };
  const call = (p, init) => sandbox.fetch(p, init || { headers: H });

  // 1. 鉴权
  const unauth = await sandbox.fetch('/api/terms', {});
  check('无 Key 访问被拒（401）', unauth.status === 401, 'status=' + unauth.status);

  // 2. 学期
  const termsRes = await call('/api/terms');
  const terms = await termsRes.json();
  check('GET /api/terms 返回 200', termsRes.status === 200, 'status=' + termsRes.status);
  check('默认学期已创建', Array.isArray(terms.items || terms.terms) && (terms.items || terms.terms).length >= 1,
    JSON.stringify((terms.items || terms.terms || []).map((t) => t.name)));

  const termList = terms.items || terms.terms;
  const termId = termList[0] && termList[0].id;
  check('取得 termId', !!termId, String(termId));

  // 3. 建课
  const createRes = await call('/api/courses', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      termId, name: '高等数学A（上）', teacher: '张伟', location: '教三-301',
      dayOfWeek: 1, startPeriod: 1, endPeriod: 2, weeks: '1-16周', credit: 5,
    }),
  });
  const created = await createRes.json();
  check('POST /api/courses 创建成功', createRes.status === 201 || createRes.ok === true, 'status=' + createRes.status);

  // 4. 周视图
  const boardRes = await call('/api/timetable?termId=' + termId + '&week=1');
  const board = await boardRes.json();
  check('GET /api/timetable 有课程', boardRes.ok && JSON.stringify(board).indexOf('高等数学') >= 0);

  // 5. 统计
  const statsRes = await call('/api/stats?termId=' + termId);
  const stats = await statsRes.json();
  check('GET /api/stats 学分正确', stats.data && stats.data.creditSum === 5, 'creditSum=' + (stats.data && stats.data.creditSum));

  // 6. ICS（纯字符串，验证折叠与 CRLF）
  const icsRes = await sandbox.fetch('/api/export?format=ics&termId=' + termId, { headers: H });
  const icsText = await icsRes.text();
  check('ICS 导出含 VCALENDAR', icsText.startsWith('BEGIN:VCALENDAR'), icsRes.status + '');
  check('ICS 使用 CRLF', icsText.indexOf('\r\n') > 0);
  check('ICS 含 RRULE 与 SUMMARY', icsText.indexOf('RRULE') > 0 && icsText.indexOf('SUMMARY:高等数学A（上）') > 0);

  // 7. XLSX（二进制，重点验证 Buffer shim）
  const xlsxRes = await sandbox.fetch('/api/export?format=xlsx&termId=' + termId, { headers: H });
  const xlsxBuf = new Uint8Array(await xlsxRes.arrayBuffer());
  const magic = String.fromCharCode(xlsxBuf[0], xlsxBuf[1], xlsxBuf[2], xlsxBuf[3]);
  check('XLSX 返回 ZIP 魔数 PK\\x03\\x04', magic === 'PK\u0003\u0004', 'magic=' + JSON.stringify(magic) + ' size=' + xlsxBuf.length);
  check('XLSX 体积合理（>1KB）', xlsxBuf.length > 1024, xlsxBuf.length + ' bytes');

  // 8. CSV 往返导入
  const csv = '课程名称,星期,开始节次,结束节次,周次,上课地点,教师,学分\n线性代数,3,3,4,1-16周,教二-201,李娜,3';
  const impRes = await call('/api/import', {
    method: 'POST', headers: H,
    body: JSON.stringify({ format: 'csv', mode: 'upsert', termId, data: csv }),
  });
  const imp = await impRes.json();
  check('CSV 导入成功', imp.ok === true, 'created=' + imp.created);

  // 9. 离线订阅地址（APK 内仍可导出 .ics 文件）
  const subRes = await call('/api/subscription?termId=' + termId);
  const sub = await subRes.json();
  const tok = sub.token;
  check('订阅令牌可获取', !!tok, String(tok));
  if (tok) {
    const pub = await sandbox.fetch('/ics/' + tok + '.ics');
    const pubText = await pub.text();
    check('/ics/:token.ics 免鉴权可访问', pub.status === 200 && pubText.indexOf('BEGIN:VCALENDAR') === 0, 'status=' + pub.status);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n─────────────────────────────');
  console.log('  通过 ' + (results.length - failed.length) + ' 项，失败 ' + failed.length + ' 项');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
