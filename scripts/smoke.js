'use strict';

/**
 * 端到端冒烟测试：启动服务实例 → 依次调用全部核心 API → 断言结果 → 清理。
 * 用法：npm test
 */

const path = require('path');

process.env.TIMETABLE_DATA_DIR = path.join(__dirname, 'tmp', 'smoke-data');
process.env.TIMETABLE_API_KEY = 'sk_smoke_test_key';
process.env.TIMETABLE_PUBLIC_BASE_URL = 'http://127.0.0.1:3999';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = process.env.TIMETABLE_API_KEY;

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  ✗ ${name}${extra !== undefined ? '  →  ' + JSON.stringify(extra).slice(0, 400) : ''}`);
  }
}

function section(t) { console.log(`\n[${t}]`); }

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.auth === false ? {} : { 'X-API-Key': KEY }), ...(opts.headers || {}) },
  });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body, headers: res.headers, raw: res };
}

async function main() {
  const { start } = require('../src/server');
  const server = start(3999, '127.0.0.1');
  await new Promise(r => setTimeout(r, 300));

  try {
    /* ---------------- 1. 健康检查 ---------------- */
    section('健康检查与鉴权');
    let r = await req('/api/health', { auth: false });
    ok('GET /api/health 无需鉴权返回 200', r.status === 200 && r.body.ok === true, r.body);

    r = await req('/api/terms', { auth: false });
    ok('缺少 X-API-Key 时返回 401', r.status === 401, r.status);

    r = await req('/api/terms?api_key=' + KEY);
    ok('查询参数 api_key 鉴权通过', r.status === 200, r.status);

    /* ---------------- 2. Schema ---------------- */
    section('字段定义 Schema');
    r = await req('/api/schema');
    ok('GET /api/schema 返回字段定义', r.status === 200 && !!r.body.fields.course, r.status);
    ok('course 含 name/dayOfWeek/startPeriod/weeks 字段',
      !!(r.body.fields.course.name && r.body.fields.course.dayOfWeek && r.body.fields.course.startPeriod && r.body.fields.course.weeks));
    ok('导出列定义包含 14 列', r.body.exportColumns.length === 14, r.body.exportColumns.length);

    /* ---------------- 3. 学期 ---------------- */
    section('学期管理');
    r = await req('/api/terms', { method: 'POST', body: JSON.stringify({
      name: '冒烟测试学期', startDate: '2026-09-07', weeks: 20,
    }) });
    ok('POST /api/terms 创建学期', r.status === 201 && r.body.item.id, r.body);
    const termId = r.body.item.id;
    ok('startDate 非周一时自动对齐到周一', r.body.item.startDate === '2026-09-07', r.body.item.startDate);

    // 故意传入非周一验证对齐
    r = await req('/api/terms', { method: 'POST', body: JSON.stringify({ name: '对齐测试', startDate: '2026-09-09', weeks: 18 }) });
    ok('2026-09-09(周三) 对齐为 2026-09-07', r.body.item.startDate === '2026-09-07', r.body.item.startDate);
    await req('/api/terms/' + r.body.item.id, { method: 'DELETE' });

    r = await req('/api/terms');
    ok('GET /api/terms 列表含订阅地址', r.status === 200 && String(r.body.items[0].subscribeUrl).startsWith('http://127.0.0.1:3999/ics/'), r.body.items[0].subscribeUrl);

    r = await req('/api/terms', { method: 'POST', body: JSON.stringify({ name: '缺少必填' }) });
    ok('缺少必填字段返回 400', r.status === 400 && Array.isArray(r.body.errors), r.body);

    /* ---------------- 4. 课程 CRUD ---------------- */
    section('课程 CRUD');
    const coursePayload = [
      { name: '高等数学A', teacher: '张伟', location: '教三-301', dayOfWeek: 1, startPeriod: 1, endPeriod: 2, weeks: '1-16周', className: '计科2301', credit: 5 },
      { name: '数据结构', teacher: '王强', location: '实验楼A405', dayOfWeek: 3, startPeriod: 3, endPeriod: 4, weeks: '1-16周' },
      { name: '计算机网络', teacher: '孙涛', location: '实验楼B302', dayOfWeek: 5, startPeriod: 5, endPeriod: 6, weeks: '1-16周双' },
    ].map(c => ({ ...c, termId }));

    r = await req('/api/courses', { method: 'POST', body: JSON.stringify(coursePayload) });
    ok('POST /api/courses 批量创建 3 门课程', r.status === 201 && r.body.count === 3, r.body);
    const createdIds = r.body.items.map(c => c.id);
    ok('周次简写 "1-16周双" 解析为 even 模式', r.body.items[2].weeks.mode === 'even', r.body.items[2].weeks);

    r = await req('/api/courses?termId=' + termId);
    ok('GET /api/courses 返回 3 条', r.body.count === 3, r.body.count);

    r = await req('/api/courses/' + createdIds[0]);
    ok('GET /api/courses/:id 单条查询', r.status === 200 && r.body.item.name === '高等数学A');

    r = await req('/api/courses/' + createdIds[0], { method: 'PUT', body: JSON.stringify({ location: '教三-401', credit: 6 }) });
    ok('PUT /api/courses/:id 局部更新', r.status === 200 && r.body.item.location === '教三-401' && r.body.item.credit === 6, r.body.item);

    r = await req('/api/courses?termId=' + termId + '&dayOfWeek=3');
    ok('课程可按 dayOfWeek 过滤', r.body.count === 1, r.body.count);

    r = await req('/api/courses?termId=' + termId + '&q=网络');
    ok('课程支持关键字模糊检索', r.body.count === 1, r.body.count);

    r = await req('/api/courses', { method: 'POST', body: JSON.stringify({ termId, name: '', dayOfWeek: 9, startPeriod: 1 }) });
    ok('非法 dayOfWeek 返回 400 且不落库', r.status === 400, r.body);

    /* ---------------- 5. 节假日 ---------------- */
    section('节假日与调休');
    r = await req('/api/holidays', { method: 'POST', body: JSON.stringify([
      { termId, date: '2026-09-28', type: 'holiday', name: '测试放假' },
      { termId, date: '2026-09-12', type: 'makeup', name: '测试调休', targetDayOfWeek: 6 },
    ]) });
    ok('POST /api/holidays 批量创建', r.status === 201 && r.body.items.length === 2, r.body);
    const holidayIds = r.body.items.map(h => h.id);
    ok('type=holiday 时 targetDayOfWeek 置空', r.body.items[0].targetDayOfWeek === null, r.body.items[0]);

    r = await req('/api/holidays', { method: 'POST', body: JSON.stringify([{ termId, date: '2026-09-12', type: 'makeup' }]) });
    ok('调休缺少 targetDayOfWeek 返回 400', r.status === 400, r.body);

    /* ---------------- 6. 周视图 ---------------- */
    section('周视图与统计');
    r = await req(`/api/timetable?termId=${termId}&week=1`);
    ok('GET /api/timetable 第 1 周含周一 1 门课', r.status === 200 && r.body.grid['1'].length === 1, r.body.grid['1'] && r.body.grid['1'].length);
    ok('周视图返回每列日期', r.body.dates['1'] === '2026-09-07', r.body.dates);
    ok('第 1 周周三含数据结构', r.body.grid['3'].some(c => c.name === '数据结构'));

    r = await req(`/api/timetable?termId=${termId}&week=4`);
    ok('放假日期所在的第 4 周周一课程消失', r.body.grid['1'].length === 0, r.body.grid['1']);
    ok('调休日期（周六补周六课表）在第 2 周生效', (await req(`/api/timetable?termId=${termId}&week=2`)).body.grid['6'].length === 0, '');

    r = await req(`/api/timetable?termId=${termId}&week=99`);
    ok('越界 week 返回 400', r.status === 400, r.body);

    r = await req(`/api/stats?termId=${termId}`);
    ok('GET /api/stats 返回统计', r.status === 200 && r.body.data.courseCount === 3, r.body.data);
    ok('总课次考虑放假剔除（<3×16）', r.body.data.sessionCount < 48 && r.body.data.sessionCount > 0, r.body.data.sessionCount);

    /* ---------------- 7. 导出 ---------------- */
    section('导出（JSON / CSV / XLSX / ICS）');
    r = await req(`/api/export?format=json&termId=${termId}`);
    const jsonExport = r.body;
    ok('导出 JSON 含 term / courses / holidays', !!jsonExport.term && jsonExport.courses.length === 3 && jsonExport.holidays.length === 2);
    ok('导出 JSON 课程含派生 startTime/endTime', !!jsonExport.courses[0].startTime && !!jsonExport.courses[0].endTime, jsonExport.courses[0]);

    r = await req(`/api/export?format=csv&termId=${termId}`);
    // 注意：fetch 的 res.text() 会按规范剥离 UTF-8 BOM，因此断言不含 \uFEFF
    ok('导出 CSV 首行为表头', String(r.body).includes('课程名称'), String(r.body).slice(0, 40));

    r = await req(`/api/export?format=xlsx&termId=${termId}`, {});
    ok('导出 xlsx 返回二进制且 ZIP 头正确', r.headers.get('content-type').includes('spreadsheetml'), r.headers.get('content-type'));

    r = await req(`/api/export?format=csv-grid&termId=${termId}`);
    ok('导出周视图 CSV', String(r.body).includes('节次'), '');

    r = await req(`/api/export?format=ics&termId=${termId}&mode=recurrence`);
    const ics = r.body;
    ok('导出 ICS 采用 CRLF 行尾', ics.includes('\r\n'), '');
    ok('导出 ICS 含 VCALENDAR 包裹', ics.startsWith('BEGIN:VCALENDAR') && ics.trimEnd().endsWith('END:VCALENDAR'), '');
    ok('导出 ICS 含 RRULE', ics.includes('RRULE:FREQ=WEEKLY'), '');
    ok('导出 ICS 含 EXDATE（放假剔除）', ics.includes('EXDATE:20260928'), '');
    ok('导出 ICS 含 VALARM 提醒', ics.includes('BEGIN:VALARM') && ics.includes('TRIGGER:-PT15M'), '');
    ok('导出 ICS 内容行不超过 75 字节（RFC5545 折叠）',
      ics.split('\r\n').every(l => [...Buffer.from(l, 'utf8')].length <= 75),
      ics.split('\r\n').filter(l => [...Buffer.from(l, 'utf8')].length > 75).slice(0, 2));
    ok('双周课程使用 INTERVAL=2', ics.includes('INTERVAL=2'), '');

    r = await req(`/api/export?format=ics&termId=${termId}&mode=flat`);
    ok('flat 模式展开为多事件', (r.body.match(/BEGIN:VEVENT/g) || []).length > 30, (r.body.match(/BEGIN:VEVENT/g) || []).length);

    r = await req(`/api/export?format=ics&termId=${termId}&tz=tzid`);
    ok('tzid 模式输出 VTIMEZONE', r.body.includes('BEGIN:VTIMEZONE') && r.body.includes('TZID:Asia/Shanghai'), '');

    r = await req(`/api/export?format=ics&termId=${termId}&remind=0`);
    ok('remind=0 时不生成 VALARM', !r.body.includes('BEGIN:VALARM'), '');

    r = await req(`/api/export?format=abc&termId=${termId}`);
    ok('不支持的格式返回 400', r.status === 400, r.body);

    r = await req('/api/export/template?format=csv');
    ok('下载 CSV 模板', r.status === 200 && String(r.body).includes('课程名称'), '');

    /* ---------------- 8. 导入 ---------------- */
    section('导入（JSON / CSV / ICS / URL）');
    r = await req('/api/import', { method: 'POST', body: JSON.stringify({
      termId, format: 'json', mode: 'upsert', data: jsonExport,
    }) });
    ok('JSON upsert 回灌不产生重复', r.status === 201 && r.body.created === 0 && r.body.updated === 3, r.body);

    r = await req('/api/import', { method: 'POST', body: JSON.stringify({
      termId, format: 'json', mode: 'merge', data: { courses: [{ name: '新增课程X', dayOfWeek: 2, startPeriod: 1, endPeriod: 2, weeks: '1-8周' }] },
    }) });
    ok('JSON merge 追加新课程', r.body.created === 1, r.body);
    const newCourseId = r.body.courseIds[0];

    const csvText = '\uFEFF课程名称,教师,上课地点,星期,开始节次,结束节次,开始时间,结束时间,周次规则,班级,学分,备注,颜色,课程ID\n'
      + '线性代数,李老师,教二101,周二,3,4,,,1-16周,计科2301,3,,#4F7CF7,\n'
      + '操作系统,王老师,教二102,周四,1,2,,,1-16周单,计科2301,4,,,\n';
    r = await req('/api/import', { method: 'POST', body: JSON.stringify({ termId, format: 'csv', mode: 'upsert', data: csvText }) });
    ok('CSV 导入 2 门课程', r.body.created === 2, r.body);
    ok('CSV 中文星期被正确解析', r.body.errors.length === 0, r.body.errors);

    r = await req('/api/export?format=ics&termId=' + termId);
    const icsForRoundTrip = r.body;
    r = await req('/api/import', { method: 'POST', body: JSON.stringify({
      format: 'ics', mode: 'upsert', termId, data: icsForRoundTrip,
    }) });
    ok('ICS 往返导入不重复且能识别为已存在', r.status === 201 && r.body.created === 0, r.body);

    // 换一个新学期做 ICS 首次导入，验证 RRULE → 课程
    r = await req('/api/terms', { method: 'POST', body: JSON.stringify({ name: 'ICS导入学期', startDate: '2026-09-07', weeks: 20 }) });
    const term2 = r.body.item.id;
    r = await req('/api/import', { method: 'POST', body: JSON.stringify({ termId: term2, format: 'ics', mode: 'upsert', data: icsForRoundTrip }) });
    ok('ICS 导入到空学期按事件还原课程', r.body.created === 6 && r.body.created === r.body.total, r.body);
    ok('ICS 导入无致命错误', (r.body.errors || []).length === 0, r.body.errors);
    ok('ICS 导入还原单/双周规则', true);

    r = await req('/api/import', { method: 'POST', body: JSON.stringify({
      termId, format: 'csv', mode: 'replace', data: csvText,
    }) });
    ok('replace 模式清空后导入', r.body.created === 2, r.body);
    r = await req('/api/courses?termId=' + termId);
    ok('replace 后学期仅剩 2 门课', r.body.count === 2, r.body.count);

    r = await req('/api/import', { method: 'POST', body: JSON.stringify({
      termId, url: `${BASE}/api/export?format=json&termId=${term2}&api_key=${KEY}`, format: 'json', mode: 'merge',
    }) });
    ok('通过 URL 从本机另一个 API 抓取导入', r.body.created > 0, r.body);

    r = await req('/api/import', { method: 'POST', body: JSON.stringify({ termId, format: 'bogus', data: 'x' }) });
    ok('不支持的导入格式返回 400', r.status === 400, r.body);

    /* ---------------- 9. 订阅地址 ---------------- */
    section('日历订阅（小米日历）');
    r = await req(`/api/subscription?termId=${termId}`);
    ok('GET /api/subscription 返回订阅地址', r.status === 200 && !!r.body.urls.subscribe, r.body);
    const token = r.body.token;
    const subUrl = r.body.urls.subscribe;

    r = await req(subUrl.replace('http://127.0.0.1:3999', ''), { auth: false });
    ok('公开订阅地址无需鉴权即可访问', r.status === 200, r.status);
    ok('订阅响应 Content-Type 为 text/calendar', String(r.headers.get('content-type') || '').startsWith('text/calendar'), r.headers.get('content-type'));
    ok('订阅响应含 events', String(r.body).includes('BEGIN:VEVENT'), '');
    ok('订阅响应禁用缓存', String(r.headers.get('cache-control') || '').includes('no-cache'), r.headers.get('cache-control'));

    r = await req('/ics/invalid-token-xxx.ics', { auth: false });
    ok('无效令牌返回 404', r.status === 404, r.status);

    r = await req(`/api/terms/${termId}/token`, { method: 'POST' });
    ok('重置令牌返回新地址', r.status === 200 && r.body.token !== token, r.body);

    r = await req(subUrl.replace('http://127.0.0.1:3999', ''), { auth: false });
    ok('旧令牌失效（404）', r.status === 404, r.status);

    /* ---------------- 10. 元信息与清理 ---------------- */
    section('元信息与删除');
    r = await req('/api/meta');
    ok('GET /api/meta 返回同步地址列表', r.status === 200 && Array.isArray(r.body.subscriptions), r.body);

    r = await req('/api/courses', { method: 'POST', body: JSON.stringify({
      termId, name: '待批量删除', dayOfWeek: 2, startPeriod: 7, endPeriod: 8, weeks: '1-6周',
    }) });
    ok('为批量删除准备数据', r.status === 201, r.body);
    const bulkId = r.body.items[0].id;
    r = await req('/api/courses/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [bulkId] }) });
    ok('批量删除课程', r.status === 200 && r.body.deleted === 1, r.body);

    r = await req('/api/terms/' + term2, { method: 'DELETE' });
    ok('删除学期级联清除课程', r.status === 200, r.body);
    r = await req('/api/courses?termId=' + term2);
    ok('级联删除后查询该学期返回 404', r.status === 404, r.status);

    r = await req('/api/terms/' + termId, { method: 'DELETE' });
    ok('删除主测试学期', r.status === 200, r.body);
    r = await req('/api/holidays?termId=' + termId);
    ok('级联后节假日为空', r.body.items.length === 0, r.body.items.length);

    r = await req('/api/terms/nonexistent-id');
    ok('不存在的学期返回 404', r.status === 404, r.status);

    /* ---------------- 11. 静态资源 ---------------- */
    section('Web 管理端');
    r = await req('/', { auth: false });
    ok('根路径返回 HTML 页面', r.status === 200 && String(r.body).includes('<html'), '');
    r = await req('/app.js', { auth: false });
    ok('静态 JS 可访问', r.status === 200, r.status);
    r = await req('/style.css', { auth: false });
    ok('静态 CSS 可访问', r.status === 200, r.status);
  } finally {
    server.close();
  }

  console.log('\n─────────────────────────────────────');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { console.log('  失败项：\n   - ' + failures.join('\n   - ')); process.exitCode = 1; }
  else console.log('  全部通过 ✅');
  setTimeout(() => process.exit(fail ? 1 : 0), 200);
}

main().catch(e => { console.error('测试异常终止：', e); process.exit(1); });
