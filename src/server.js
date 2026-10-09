'use strict';

/**
 * HTTP 服务层：基于 Node 内置 http 模块实现的轻量 RESTful 服务（零第三方依赖）。
 *
 * 路由分组：
 *   /api/**                  —— 业务 API，需 API Key
 *   /ics/:token.ics          —— 公开日历订阅地址（安卓/iOS/小米日历直接访问）
 *   /                        —— Web 管理端静态资源
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const store = require('./store');
const model = require('./model');
const exporters = require('./exporters');
const importers = require('./importers');
const { buildJsonSchema, ValidationError, expandCourseOccurrences, weekOfDate, weekMonday, courseTimeRange, formatWeeksRule } = require('./model');
const { randomToken, toDateStr, todayStr, parseDate, addDays } = require('./util');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const MAX_BODY = 12 * 1024 * 1024; // 12MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ============================== 基础工具 ============================== */

function sendJSON(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'X-Request-Id': randomToken(8),
  });
  res.end(body);
}

function sendRaw(res, status, body, headers) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const h = {
    'Content-Type': headers['Content-Type'] || 'application/octet-stream',
    'Content-Length': buf.length,
    ...headers,
  };
  res.writeHead(status, h);
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('请求体过大（上限 12MB）'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});
      const ct = String(req.headers['content-type'] || '');
      try {
        if (/application\/json/i.test(ct) || /^\s*[{\[]/.test(buf.toString('utf8').trim().slice(0, 1))) {
          resolve(JSON.parse(buf.toString('utf8')));
        } else if (/multipart\/form-data/i.test(ct)) {
          resolve({ _multipart: buf, _contentType: ct });
        } else if (/text\/(plain|csv|calendar)/i.test(ct) || /text\/csv/i.test(ct)) {
          resolve({ data: buf.toString('utf8') });
        } else {
          try { resolve(JSON.parse(buf.toString('utf8'))); }
          catch (e) { resolve({ data: buf.toString('utf8') }); }
        }
      } catch (e) {
        reject(Object.assign(new Error('JSON 解析失败：' + e.message), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** 极简 multipart/form-data 解析：够用即可，仅提取字段与文件内容 */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new Error('缺少 multipart boundary');
  const boundary = '--' + (m[1] || m[2]);
  const enc = 'binary';
  const text = buf.toString(enc);
  const result = { fields: {}, files: [] };
  const parts = text.split(boundary);
  for (const part of parts) {
    if (!part || part === '--\r\n' || part.trim() === '--') continue;
    const idx = part.indexOf('\r\n\r\n');
    if (idx < 0) continue;
    const head = part.slice(0, idx);
    let body = part.slice(idx + 4);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    const nameM = /name="([^"]+)"/i.exec(head);
    const fileM = /filename="([^"]*)"/i.exec(head);
    const ctM = /Content-Type:\s*([^\r\n]+)/i.exec(head);
    if (fileM) {
      result.files.push({
        field: nameM ? nameM[1] : 'file',
        filename: fileM[1],
        contentType: ctM ? ctM[1] : '',
        content: Buffer.from(body, enc),
      });
    } else if (nameM) {
      result.fields[nameM[1]] = Buffer.from(body, enc).toString('utf8');
    }
  }
  return result;
}

function matchRoute(pattern, pathname) {
  const p = pattern.split('/').filter(Boolean);
  const q = pathname.split('/').filter(Boolean);
  if (p.length !== q.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) {
      // 支持带字面量后缀的占位符，如 '/ics/:token.ics'
      const dot = p[i].indexOf('.');
      if (dot > 1) {
        const suffix = p[i].slice(dot);
        if (q[i].toLowerCase().endsWith(suffix.toLowerCase())) {
          params[p[i].slice(1, dot)] = decodeURIComponent(q[i].slice(0, q[i].length - suffix.length));
          continue;
        }
        return null;
      }
      params[p[i].slice(1)] = decodeURIComponent(q[i]);
    } else if (p[i] !== q[i]) return null;
  }
  return params;
}

function baseUrlOf(req) {
  const cfg = store.config;
  if (cfg.publicBaseUrl) return String(cfg.publicBaseUrl).replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

function requireAuth(req, query) {
  const cfg = store.config;
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || query.api_key || query.token;
  if (!key || key !== cfg.apiKey) {
    const err = new Error('未授权：请使用请求头 X-API-Key: <API_KEY> 或查询参数 ?api_key=<API_KEY>');
    err.status = 401;
    throw err;
  }
  return true;
}

function resolveTermId(query, body = {}) {
  const id = query.termId || body.termId || null;
  if (id) return id;
  return store.currentTermId();
}

function requireTerm(termId) {
  const t = store.getTermRaw(termId);
  if (!t) {
    const err = new Error(`学期不存在: ${termId || '(未指定)'}；请先在 /api/terms 创建学期，或传入 termId`);
    err.status = 404;
    throw err;
  }
  return t;
}

/* ============================== 路由表 ============================== */

const routes = [];

function route(method, pattern, handler, { auth = true } = {}) {
  routes.push({ method, pattern, handler, auth });
}

/* ---------------------- 健康检查 / 元信息 ---------------------- */

route('GET', '/api/health', (_req, _res, { query }) => ({
  status: 200,
  json: {
    ok: true,
    service: 'student-timetable-system',
    version: '1.0.0',
    time: new Date().toISOString(),
    timezone: store.config.timezone,
    terms: store.db.terms.length,
    courses: store.db.courses.length,
    authRequired: true,
    authHint: '除 /api/health 与 /ics/:token.ics 外，所有 /api 接口需要 X-API-Key',
  },
}), { auth: false });

route('GET', '/api/schema', () => ({
  status: 200,
  json: {
    version: 1,
    fields: model.FIELD_DEFS,
    exportColumns: model.EXPORT_COLUMNS,
    jsonSchema: buildJsonSchema(),
    enums: {
      weeksMode: ['all', 'odd', 'even', 'range', 'list'],
      dayOfWeek: [1, 2, 3, 4, 5, 6, 7],
      holidayType: ['holiday', 'makeup'],
      exportFormat: ['json', 'csv', 'csv-grid', 'xlsx', 'ics'],
      importFormat: ['json', 'csv', 'ics'],
      icsMode: ['recurrence', 'flat'],
      icsTz: ['floating', 'tzid'],
      importMode: ['upsert', 'merge', 'replace'],
    },
  },
}));

route('GET', '/api/meta', (_req, res, ctx) => {
  const cfg = store.config;
  return {
    status: 200,
    json: {
      publicBaseUrl: baseUrlOf(ctx.req),
      timezone: cfg.timezone,
      icsMode: cfg.icsMode,
      remindBeforeMinutes: cfg.remindBeforeMinutes,
      subscriptions: store.db.terms.map(t => ({
        termId: t.id,
        termName: t.name,
        token: t.subscriptionToken,
        subscribeUrl: `${baseUrlOf(ctx.req)}/ics/${t.subscriptionToken}.ics`,
      })),
    },
  };
});

/* ---------------------- 学期 CRUD ---------------------- */

route('GET', '/api/terms', (_req, _res, ctx) => ({
  status: 200,
  json: { ok: true, items: store.listTerms().map(t => ({ ...t, subscribeUrl: `${baseUrlOf(ctx.req)}${t.icsUrl}` })) },
}));

route('POST', '/api/terms', (_req, _res, { body }) => {
  const t = store.createTerm(body);
  return { status: 201, json: { ok: true, item: t } };
});

route('GET', '/api/terms/:id', (_req, _res, { params, query, req }) => {
  const t = requireTerm(params.id);
  return {
    status: 200,
    json: {
      ok: true,
      item: t,
      subscribeUrl: `${baseUrlOf(req)}/ics/${t.subscriptionToken}.ics`,
      apiSubscribeUrl: `${baseUrlOf(req)}/api/pub/calendar/${t.subscriptionToken}.ics`,
    },
  };
});

route('PUT', '/api/terms/:id', (_req, _res, { params, body }) => {
  const t = store.updateTerm(params.id, body);
  if (!t) { const e = new Error('学期不存在'); e.status = 404; throw e; }
  return { status: 200, json: { ok: true, item: t } };
});

route('DELETE', '/api/terms/:id', (_req, _res, { params }) => {
  const ok = store.deleteTerm(params.id);
  if (!ok) { const e = new Error('学期不存在'); e.status = 404; throw e; }
  return { status: 200, json: { ok: true, deleted: params.id } };
});

route('POST', '/api/terms/:id/token', (_req, _res, { params, req }) => {
  const t = store.rotateTermToken(params.id);
  if (!t) { const e = new Error('学期不存在'); e.status = 404; throw e; }
  return { status: 200, json: { ok: true, token: t.subscriptionToken, subscribeUrl: `${baseUrlOf(req)}/ics/${t.subscriptionToken}.ics` } };
});

/* ---------------------- 课程 CRUD ---------------------- */

route('GET', '/api/courses', (_req, _res, { query }) => {
  const termId = resolveTermId(query);
  if (!termId) return { status: 200, json: { ok: true, termId: null, items: [] } };
  requireTerm(termId);
  const items = store.listCourses({
    termId, dayOfWeek: query.dayOfWeek, teacher: query.teacher, q: query.q,
  });
  return { status: 200, json: { ok: true, termId, count: items.length, items } };
});

route('POST', '/api/courses', (_req, _res, { body, query }) => {
  const termId = body.termId || query.termId || store.currentTermId();
  requireTerm(termId);
  const list = Array.isArray(body) ? body : (body.courses && Array.isArray(body.courses) ? body.courses : [body]);
  const payload = list.map(c => ({ ...c, termId: c.termId || termId }));
  const items = store.bulkCreateCourses(payload);
  return { status: 201, json: { ok: true, count: items.length, items } };
});

route('GET', '/api/courses/:id', (_req, _res, { params }) => {
  const c = store.getCourse(params.id);
  if (!c) { const e = new Error('课程不存在'); e.status = 404; throw e; }
  return { status: 200, json: { ok: true, item: c } };
});

route('PUT', '/api/courses/:id', (_req, _res, { params, body }) => {
  const c = store.updateCourse(params.id, body);
  if (!c) { const e = new Error('课程不存在'); e.status = 404; throw e; }
  return { status: 200, json: { ok: true, item: c } };
});

route('DELETE', '/api/courses/:id', (_req, _res, { params }) => {
  const ok = store.deleteCourse(params.id);
  if (!ok) { const e = new Error('课程不存在'); e.status = 404; throw e; }
  return { status: 200, json: { ok: true, deleted: params.id } };
});

route('POST', '/api/courses/bulk-delete', (_req, _res, { body }) => {
  const ids = Array.isArray(body) ? body : (body.ids || []);
  const n = store.bulkDeleteCourses(ids);
  return { status: 200, json: { ok: true, deleted: n } };
});

/* ---------------------- 节假日 / 调休 ---------------------- */

route('GET', '/api/holidays', (_req, _res, { query }) => {
  const termId = resolveTermId(query);
  return { status: 200, json: { ok: true, termId, items: store.listHolidays(termId) } };
});

route('POST', '/api/holidays', (_req, _res, { body, query }) => {
  const list = Array.isArray(body) ? body : [body];
  const termId = body.termId || query.termId || store.currentTermId();
  const items = list.map(h => store.createHoliday({ ...h, termId: h.termId || termId }));
  return { status: 201, json: { ok: true, items } };
});

route('PUT', '/api/holidays/:id', (_req, _res, { params, body }) => {
  const h = store.updateHoliday(params.id, body);
  if (!h) { const e = new Error('记录不存在'); e.status = 404; throw e; }
  return { status: 200, json: { ok: true, item: h } };
});

route('DELETE', '/api/holidays/:id', (_req, _res, { params }) => {
  const ok = store.deleteHoliday(params.id);
  if (!ok) { const e = new Error('记录不存在'); e.status = 404; throw e; }
  return { status: 200, json: { ok: true, deleted: params.id } };
});

/* ---------------------- 课表视图 / 统计 ---------------------- */

route('GET', '/api/timetable', (_req, _res, { query }) => {
  const termId = resolveTermId(query);
  const term = requireTerm(termId);
  const week = query.week ? Number(query.week) : (weekOfDate(term, todayStr(store.config.timezone)) || 1);
  if (!Number.isInteger(week) || week < 1 || week > term.weeks) {
    const e = new Error(`week 必须是 1-${term.weeks} 的整数`); e.status = 400; throw e;
  }
  const holidays = store.listHolidays(termId);
  const monday = weekMonday(term, week);
  const grid = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
  const dateMap = {};
  for (let d = 1; d <= 7; d++) dateMap[d] = toDateStr(addDays(monday, d - 1));

  for (const c of store.listCourses({ termId })) {
    const occurrences = expandCourseOccurrences(term, c, holidays).filter(o => o.week === week);
    if (!occurrences.length) continue;
    const range = courseTimeRange(term, c) || { startTime: '', endTime: '' };
    grid[c.dayOfWeek].push({
      ...c,
      date: dateMap[c.dayOfWeek],
      startTime: range.startTime,
      endTime: range.endTime,
      weeksText: formatWeeksRule(c.weeks, term.weeks),
      isMakeup: !!occurrences[0].makeup,
    });
  }
  for (const d of Object.keys(grid)) grid[d].sort((a, b) => a.startPeriod - b.startPeriod);
  return {
    status: 200,
    json: {
      ok: true, termId, week, termWeeks: term.weeks,
      weekMonday: toDateStr(monday),
      dates: dateMap,
      holidays: holidays.filter(h => Object.values(dateMap).includes(h.date)),
      periods: term.periods,
      grid,
    },
  };
});

route('GET', '/api/stats', (_req, _res, { query }) => {
  const termId = resolveTermId(query);
  if (!termId) return { status: 200, json: { ok: true, empty: true } };
  requireTerm(termId);
  return { status: 200, json: { ok: true, data: store.stats(termId) } };
});

/* ---------------------- 导出 ---------------------- */

function contentDisposition(res, filename, inline) {
  const enc = encodeURIComponent(filename);
  return {
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="timetable"; filename*=UTF-8''${enc}`,
  };
}

route('GET', '/api/export', (_req, _res, { query }) => {
  const termId = resolveTermId(query);
  requireTerm(termId);
  const fmt = (query.format || 'json').toLowerCase();
  const download = String(query.download || '1') !== '0';
  const opts = {
    includeOccurrences: /^(1|true|occurrences)$/i.test(String(query.include || '')),
    mode: query.mode || undefined,
    tz: query.tz || undefined,
    remindBeforeMinutes: query.remind !== undefined ? Number(query.remind) : undefined,
    titleTemplate: query.title || undefined,
    pretty: String(query.pretty || '1') !== '0',
  };
  let out;
  switch (fmt) {
    case 'json': out = exporters.exportJSON(termId, opts); break;
    case 'csv': out = exporters.exportCSV(termId); break;
    case 'csv-grid': case 'grid': out = exporters.exportCSVGrid(termId); break;
    case 'xlsx': case 'excel': out = exporters.exportXlsx(termId); break;
    case 'ics': case 'ical': out = exporters.exportICS(termId, opts); break;
    default: {
      const e = new Error(`不支持的导出格式: ${fmt}（支持 json / csv / csv-grid / xlsx / ics）`);
      e.status = 400; throw e;
    }
  }
  if (!out) { const e = new Error('导出失败：学期不存在'); e.status = 404; throw e; }
  return {
    status: 200,
    raw: out.body,
    headers: {
      'Content-Type': out.contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Export-Format': fmt,
      ...(download ? contentDisposition(null, out.filename, false) : {}),
    },
  };
});

route('GET', '/api/export/template', (_req, _res, { query }) => {
  const fmt = (query.format || 'csv').toLowerCase();
  if (fmt === 'xlsx' || fmt === 'excel') {
    const buf = exporters.exportXlsxWithRows([model.EXPORT_COLUMNS.map(c => c.header)], true);
    return {
      status: 200, raw: buf,
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ...contentDisposition(null, '课表导入模板.xlsx', false) },
    };
  }
  if (fmt === 'csv') {
    const rows = [model.EXPORT_COLUMNS.map(c => c.header), ['高等数学', '张三', '教三-301', '周一', 1, 2, '08:00', '09:40', '1-16周', '计科2301', 4, '示例行，导入时删除', '#4F7CF7', '']];
    const { toCSV } = require('./util');
    return {
      status: 200, raw: toCSV(rows),
      headers: { 'Content-Type': 'text/csv; charset=utf-8', ...contentDisposition(null, '课表导入模板.csv', false) },
    };
  }
  const e = new Error(`模板格式仅支持 csv / xlsx`); e.status = 400; throw e;
});

/* ---------------------- 导入 ---------------------- */

route('POST', '/api/import', async (req, _res, { body, query }) => {
  let input = body || {};
  let opts = {
    termId: body.termId || query.termId || null,
    format: body.format || query.format || 'auto',
    mode: body.mode || query.mode || 'upsert',
    applyDefaults: body.applyDefaults || undefined,
  };

  if (body._multipart) {
    const mp = parseMultipart(body._multipart, body._contentType || '');
    const file = mp.files[0];
    if (!file) { const e = new Error('multipart 请求中未找到上传文件（字段名 file）'); e.status = 400; throw e; }
    input = {
      data: file.content.toString('utf8'),
      contentType: file.contentType || '',
    };
    opts = {
      termId: mp.fields.termId || opts.termId,
      format: mp.fields.format || 'auto',
      mode: mp.fields.mode || 'upsert',
      applyDefaults: opts.applyDefaults,
    };
  } else if (typeof body.data === 'object' && body.data !== null && (opts.format === 'json' || opts.format === 'auto')) {
    input = { data: JSON.stringify(body.data), contentType: 'application/json' };
  }

  if (!['upsert', 'merge', 'replace'].includes(opts.mode)) {
    const e = new Error(`mode 仅支持 upsert / merge / replace`); e.status = 400; throw e;
  }
  const result = await importers.runImport(input, opts);
  return { status: result && result.ok === false ? 422 : 201, json: { ok: result.ok !== false, ...result } };
});

/* ---------------------- 订阅地址管理 ---------------------- */

route('GET', '/api/subscription', (_req, _res, { query, req }) => {
  const termId = resolveTermId(query);
  const term = requireTerm(termId);
  const base = baseUrlOf(req);
  return {
    status: 200,
    json: {
      ok: true,
      termId: term.id,
      termName: term.name,
      token: term.subscriptionToken,
      urls: {
        subscribe: `${base}/ics/${term.subscriptionToken}.ics`,
        subscribeApi: `${base}/api/pub/calendar/${term.subscriptionToken}.ics`,
        download: `${base}/api/export?format=ics&termId=${term.id}&api_key=<API_KEY>`,
        recurrence: `${base}/ics/${term.subscriptionToken}.ics?mode=recurrence&tz=floating`,
        flat: `${base}/ics/${term.subscriptionToken}.ics?mode=flat`,
      },
      compatibility: {
        contentType: 'text/calendar; charset=utf-8; component=vevent; method=PUBLISH',
        auth: '无需认证，URL 中的 token 即为凭据；请妥善保管，重置请调用 POST /api/terms/:id/token',
        refreshHintSeconds: 3600,
      },
    },
  };
});

/* ---------------------- 公开日历订阅 ---------------------- */

/** 公开订阅地址允许的调整参数 */

route('GET', '/ics/:token.ics', (_req, _res, { params, query }) => {
  const term = store.getTermByToken(params.token);
  if (!term) { const e = new Error('订阅地址无效或已失效'); e.status = 404; throw e; }
  const cfg = store.config;
  const out = exporters.exportICS(term.id, {
    mode: query.mode || cfg.icsMode,
    tz: query.tz || 'floating',
    remindBeforeMinutes: query.remind !== undefined ? Number(query.remind) : cfg.remindBeforeMinutes,
    titleTemplate: query.title || undefined,
    domain: query.domain || undefined,
  });
  return {
    status: 200,
    raw: out.body,
    headers: {
      'Content-Type': out.contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Content-Language': 'zh-CN',
      ...(String(query.download || '') === '1' ? contentDisposition(null, out.filename, false) : {}),
    },
  };
}, { auth: false });

route('GET', '/api/pub/calendar/:token.ics', (_req, _res, { params, query }) => {
  const term = store.getTermByToken(params.token);
  if (!term) { const e = new Error('订阅地址无效或已失效'); e.status = 404; throw e; }
  const out = exporters.exportICS(term.id, {
    mode: query.mode || store.config.icsMode,
    tz: query.tz || 'floating',
    remindBeforeMinutes: query.remind !== undefined ? Number(query.remind) : store.config.remindBeforeMinutes,
  });
  return { status: 200, raw: out.body, headers: { 'Content-Type': out.contentType, 'Cache-Control': 'no-cache' } };
}, { auth: false });

/* ============================== 静态资源 ============================== */

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel.includes('..')) { sendJSON(res, 403, { ok: false, error: '非法路径' }); return; }
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    sendJSON(res, 404, { ok: false, error: '资源不存在: ' + pathname, hint: '管理界面位于 /' });
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

/* ============================== 服务主循环 ============================== */

async function handle(req, res) {
  const started = Date.now();
  let u;
  try {
    u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    sendJSON(res, 400, { ok: false, error: '非法 URL' }); return;
  }
  const pathname = u.pathname.replace(/\/+$/, '') || '/';
  const method = (req.method || 'GET').toUpperCase();

  // CORS：允许跨域调用（含 OPTIONS 预检），便于自建前端 / 小程序调用
  const origin = req.headers.origin || '*';
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-API-Key,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  const prevWriteHead = res.writeHead.bind(res);
  res.writeHead = (status, headers) => prevWriteHead(status, { ...corsHeaders, ...(headers || {}) });

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const ctx = { req, res, pathname, method };

  try {
    for (const r of routes) {
      if (r.method !== method) continue;
      const params = matchRoute(r.pattern, pathname);
      if (!params) continue;
      const query = Object.fromEntries(u.searchParams.entries());
      const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
      const body = needsBody ? await readBody(req) : {};
      Object.assign(ctx, { params, query, body });
      if (r.auth) requireAuth(req, query);
      const result = await r.handler(req, res, ctx);
      if (!result) { sendJSON(res, 204, {}); return; }
      if (result.raw !== undefined) {
        sendRaw(res, result.status || 200, result.raw, result.headers || {});
      } else {
        sendJSON(res, result.status || 200, result.json);
      }
      console.log(`${method} ${pathname} -> ${result.status || 200} (${Date.now() - started}ms)`);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    const status = err.status || (err instanceof ValidationError ? 400 : 500);
    if (status >= 500) console.error('[error]', method, pathname, err);
    const payload = {
      ok: false,
      error: err.message || '服务器内部错误',
      ...(err.errors ? { errors: err.errors } : {}),
      ...(status === 401 ? { hint: '请在请求头附加 X-API-Key，或查询参数 ?api_key=…；服务端启动时会在控制台打印 API Key' } : {}),
    };
    sendJSON(res, status, payload);
  }
}

function start(portOverride, hostOverride) {
  store.init();
  const cfg = store.config;
  const port = Number(portOverride || cfg.port || 3000);
  const host = hostOverride || cfg.host || '0.0.0.0';
  const server = http.createServer((req, res) => { handle(req, res); });

  // 优雅退出：确保内存数据落盘
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('\n[shutdown] 正在保存数据…');
      try { store.flushDB(); } catch (e) { console.error(e); }
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    });
  }

  server.listen(port, host, () => {
    const net = require('os');
    const ifs = net.networkInterfaces();
    const lan = Object.values(ifs).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
    const base = cfg.publicBaseUrl ? String(cfg.publicBaseUrl).replace(/\/+$/, '') : null;
    console.log('');
    console.log('  学生课表系统已启动');
    console.log('  ────────────────────────────────────────────');
    console.log(`  监听地址      : ${host}:${port}${host === '0.0.0.0' ? '（所有网卡 / 公网可达）' : ''}`);
    console.log(`  本机访问      : http://localhost:${port}/`);
    lan.forEach(ip => console.log(`  局域网访问    : http://${ip}:${port}/`));
    if (base) console.log(`  对外基址      : ${base}/   （已配置 publicBaseUrl，订阅地址一律使用它）`);
    console.log(`  API Key       : ${cfg.apiKey}`);
    console.log(`  数据目录      : ${store.DATA_DIR}`);
    console.log('  ────────────────────────────────────────────');
    if (store.db.terms.length) {
      console.log('  日历订阅地址（小米日历「添加订阅日历」直接用）:');
      const hosts = base ? [base] : lan.map(ip => `http://${ip}:${port}`).concat([`http://localhost:${port}`]);
      hosts.forEach(h => store.db.terms.forEach(t =>
        console.log(`    ${t.name}: ${h}/ics/${t.subscriptionToken}.ics`)));
    }
    if (host === '0.0.0.0' || host === '::') {
      console.log('');
      console.log('  ⚠ 已对所有网卡开放，请确认以下 3 点：');
      console.log('    1) 已放行防火墙入站 TCP ' + port + '（见 scripts/open-firewall.ps1）');
      console.log('    2) 真正的公网访问还需路由器端口映射 / 内网穿透 / 公网主机');
      console.log('    3) 公网场景务必用 Nginx/Caddy 反代开启 HTTPS，避免 API Key 与订阅令牌明文传输');
    }
    console.log('');
  });
  return server;
}

module.exports = { start, routes, handle };

if (require.main === module) start();
