'use strict';

/**
 * 南京工业职业技术大学（njpi.edu.cn）教务课表 → 学生课表系统 一键导入。
 *
 * 原理：教务「学生课表」页面是 Vue 单页应用，其数据来自
 *   https://jwxt.njpi.edu.cn/eams-micro-server/api/v1/**
 * 鉴权方式为请求头 X-Id-Token（取自页面 URL 的 ?idToken= 参数，需去掉末尾的 "#/"）。
 *
 * 用法：
 *   node scripts/import-njpi.js --token <idToken>
 *   NJPI_TOKEN=xxx node scripts/import-njpi.js --base http://127.0.0.1:3000 --drop-demo
 *
 * 常用参数：
 *   --token        教务 idToken（也可用环境变量 NJPI_TOKEN；务必不要提交到代码仓库）
 *   --base         本系统地址，默认 http://127.0.0.1:3000
 *   --api-key      本系统 API Key，默认读取 data/config.json
 *   --term-name    导入后的学期名，默认取教务返回的学期名
 *   --semester-id  指定教务学期 id，默认取「当前学期」
 *   --drop-demo    删除示例学期「2026-2027学年 秋季学期」
 *   --dry-run      只解析并打印，不写入本系统
 *   --out <file>   把转换后的 JSON 保存到文件
 */

const fs = require('fs');
const path = require('path');

const EAMS = 'https://jwxt.njpi.edu.cn/eams-micro-server/api/v1';
const WD = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const PALETTE = ['#4F7CF7', '#7C5CFF', '#17B26A', '#F79009', '#EE46BC', '#0BA5EC', '#F04438', '#12B76A', '#DD2590', '#84CAFF'];

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        o[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        // 布尔开关：只有后一项不是 --xxx 时才把它当作取值
        const next = argv[i + 1];
        const hasValue = next !== undefined && !String(next).startsWith('--');
        o[a.slice(2)] = hasValue ? next : true;
        if (hasValue) i++;
      }
    } else o._.push(a);
  }
  return o;
}

const args = parseArgs(process.argv);
const TOKEN = args.token || process.env.NJPI_TOKEN || (args._[0] || '');
const BASE = (args.base || process.env.TIMETABLE_BASE || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const DRY = !!args['dry-run'];

if (!TOKEN) {
  console.error('缺少教务 idToken。用法：node scripts/import-njpi.js --token <idToken>');
  console.error('提示：idToken 取自教务课表页面 URL 中 ?idToken= 之后、#/ 之前的部分。');
  process.exit(2);
}

/* ------------------------------ 工具 ------------------------------ */

function hhmm(n) {
  const s = String(n).padStart(4, '0');
  return `${s.slice(0, 2)}:${s.slice(2)}`;
}

function colorOf(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** 把周次数组归纳为更紧凑的规则：连续→range；步长2→odd/even；否则 list */
function toWeeksRule(weeks) {
  const w = [...new Set(weeks)].filter(x => x >= 1).sort((a, b) => a - b);
  if (!w.length) return { mode: 'list', list: [] };
  const min = w[0], max = w[w.length - 1];
  if (max - min + 1 === w.length) return { mode: 'range', start: min, end: max };
  if (w.length > 2 && w.every((x, i) => i === 0 || x - w[i - 1] === 2)) {
    return { mode: min % 2 === 1 ? 'odd' : 'even', start: min, end: max };
  }
  return { mode: 'list', list: w };
}

async function eamsGet(p, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(EAMS + p, {
        headers: { 'X-Id-Token': TOKEN, 'content-type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (j.result !== 0 && j.result !== undefined) throw new Error(j.message || 'result=' + j.result);
      return j.data;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

async function api(pathname, opts = {}, apiKey) {
  const res = await fetch(BASE + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, ...(opts.headers || {}) },
  });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}: ${(body && body.error) || body}`);
  return body;
}

/* ------------------------------ 主流程 ------------------------------ */

(async function main() {
  console.log('① 读取教务数据…');
  const semInfo = await eamsGet('/semester/current-semester');
  const semId = args['semester-id'] || semInfo.id;
  console.log(`   学期：${semInfo.nameZh}（id=${semId}，${semInfo.startDate} 起，共 ${semInfo.weekIndices.length} 周）`);

  const table = await eamsGet(`/lesson/student/course-table/${semId}`);
  const lessons = Object.values(table || {});
  console.log(`   课表：${lessons.length} 门`);

  const bizTypeId = (lessons[0] || {}).bizTypeId || 2;
  let units = [];
  try {
    units = await eamsGet(`/system/course-units?bizTypeId=${bizTypeId}&semesterId=${semId}`) || [];
  } catch (e) {
    console.warn('   （节次表获取失败，改用课程自带时间）', e.message);
  }
  let currentWeek = null;
  try { currentWeek = await eamsGet(`/semester/current-week/${semId}`); } catch (e) { /* 可忽略 */ }
  console.log(`   节次表：${units.length} 节${currentWeek ? `，当前第 ${currentWeek} 周` : ''}`);

  /* -------- 节次时间表 -------- */
  const periods = units.length
    ? units.map(u => ({
        index: u.indexNo,
        name: `第${u.indexNo}节`,
        startTime: hhmm(u.startTime),
        endTime: hhmm(u.endTime),
      })).sort((a, b) => a.index - b.index)
    : [
      { index: 1, name: '第1节', startTime: '08:20', endTime: '09:05' },
      { index: 2, name: '第2节', startTime: '09:15', endTime: '10:00' },
      { index: 3, name: '第3节', startTime: '10:20', endTime: '11:05' },
      { index: 4, name: '第4节', startTime: '11:15', endTime: '12:00' },
      { index: 5, name: '第5节', startTime: '13:30', endTime: '14:15' },
      { index: 6, name: '第6节', startTime: '14:25', endTime: '15:10' },
      { index: 7, name: '第7节', startTime: '15:30', endTime: '16:15' },
      { index: 8, name: '第8节', startTime: '16:25', endTime: '17:10' },
      { index: 9, name: '第9节', startTime: '18:30', endTime: '19:15' },
      { index: 10, name: '第10节', startTime: '19:25', endTime: '20:10' },
    ];

  /* -------- 课程转换 -------- */
  const courses = [];
  const skipped = [];
  for (const L of lessons) {
    const course = L.course || {};
    const name = course.nameZh || '未命名课程';
    const teacher = (L.teacherAssignmentList || []).filter(Boolean).join('、');
    const credit = course.credits ?? null;
    const scheds = L.schedules || [];
    if (!scheds.length) { skipped.push(`${name}（教务未安排具体上课时间）`); continue; }

    // 按「星期 + 节次 + 时间 + 地点」归并，得到可直接落库的课程条目
    const groups = new Map();
    for (const s of scheds) {
      const place = s.customPlace || (s.room && (s.room.nameZh || s.room.name)) || '';
      const key = [s.weekday, s.startUnit, s.endUnit, s.startTime, s.endTime, place].join('|');
      if (!groups.has(key)) groups.set(key, { s, weeks: [] });
      groups.get(key).weeks.push(s.weekIndex);
    }

    const noteBase = [];
    if (course.code) noteBase.push(`课程代码 ${course.code}`);
    if (L.openDepartment && L.openDepartment.nameZh) noteBase.push(L.openDepartment.nameZh);
    const stext = L.scheduleText && L.scheduleText.dateTimePlaceText && L.scheduleText.dateTimePlaceText.textZh;
    if (stext) noteBase.push(stext.replace(/\n/g, ' '));
    if (L.courseType && L.courseType.nameZh) noteBase.push(L.courseType.nameZh);

    for (const g of groups.values()) {
      const s = g.s;
      const place = s.customPlace || (s.room && (s.room.nameZh || s.room.name)) || '';
      const rule = toWeeksRule(g.weeks);
      const weeksText = (() => {
        const w = [...new Set(g.weeks)].sort((a, b) => a - b);
        if (rule.mode === 'range') return `${rule.start}-${rule.end}周`;
        if (rule.mode === 'odd') return `${rule.start}-${rule.end}周(单)`;
        if (rule.mode === 'even') return `${rule.start}-${rule.end}周(双)`;
        return w.join(',') + '周';
      })();
      courses.push({
        name,
        teacher,
        location: place,
        dayOfWeek: s.weekday,                 // 教务 weekday：1=周一 … 7=周日（已核对 2026-09-16 周三 → 3）
        startPeriod: s.startUnit,
        endPeriod: s.endUnit || s.startUnit,
        startTime: hhmm(s.startTime),
        endTime: hhmm(s.endTime),
        weeks: rule,
        credit,
        className: '',
        note: noteBase.concat(`[${WD[s.weekday]} ${weeksText}]`).join(' · '),
        color: colorOf(name),
      });
    }
  }

  courses.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startPeriod - b.startPeriod);

  const termName = args['term-name'] || semInfo.nameZh || semInfo.schoolYear || '导入学期';
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    generator: 'import-njpi/1.0',
    term: {
      name: termName,
      startDate: semInfo.startDate,
      weeks: semInfo.weekIndices ? semInfo.weekIndices.length : 20,
      periods,
    },
    courses,
    holidays: [],
  };

  console.log(`\n② 转换完成：${courses.length} 条上课安排（来自 ${lessons.length} 门课）`);
  if (skipped.length) {
    console.log(`   跳过 ${skipped.length} 门：`);
    skipped.forEach(s => console.log('     - ' + s));
  }
  console.log('   按星期分布：');
  const byDay = {};
  courses.forEach(c => { byDay[c.dayOfWeek] = (byDay[c.dayOfWeek] || 0) + 1; });
  Object.keys(byDay).sort().forEach(d => console.log(`     ${WD[d]}：${byDay[d]} 条`));

  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(payload, null, 2), 'utf8');
    console.log(`\n   已保存：${args.out}`);
  }

  if (DRY) {
    console.log('\n（--dry-run 模式，未写入本系统）');
    console.log(JSON.stringify(payload.term, null, 2));
    return;
  }

  /* -------- 写入本系统 -------- */
  const cfgPath = path.resolve(__dirname, '..', 'data', 'config.json');
  const apiKey = args['api-key'] || process.env.TIMETABLE_API_KEY || (fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')).apiKey : '');
  if (!apiKey) { console.error('未找到本系统 API Key，请用 --api-key 指定'); process.exit(2); }

  console.log(`\n③ 写入本系统 ${BASE} …`);

  if (args['drop-demo']) {
    const terms = await api('/api/terms', {}, apiKey);
    const demo = (terms.items || []).find(t => t.name === '2026-2027学年 秋季学期');
    if (demo) {
      await api('/api/terms/' + demo.id, { method: 'DELETE' }, apiKey);
      console.log('   已删除示例学期：' + demo.name);
    }
  }

  // 幂等：同名学期复用，否则新建
  const terms = await api('/api/terms', {}, apiKey);
  let term = (terms.items || []).find(t => t.name === termName);
  if (term) {
    term = await api('/api/terms/' + term.id, {
      method: 'PUT',
      body: JSON.stringify({ startDate: payload.term.startDate, weeks: payload.term.weeks, periods: payload.term.periods }),
    }, apiKey).then(r => r.item);
    console.log('   复用同名学期：' + term.id);
  } else {
    term = await api('/api/terms', { method: 'POST', body: JSON.stringify(payload.term) }, apiKey).then(r => r.item);
    console.log('   新建学期：' + term.id);
  }

  const result = await api('/api/import', {
    method: 'POST',
    body: JSON.stringify({ format: 'json', mode: 'replace', termId: term.id, data: payload }),
  }, apiKey);
  console.log(`   导入结果：新增 ${result.created}，更新 ${result.updated}，跳过 ${result.skipped}，错误 ${(result.errors || []).length}`);
  if ((result.errors || []).length) console.log(JSON.stringify(result.errors, null, 2));

  const sub = await api(`/api/subscription?termId=${term.id}`, {}, apiKey);
  const st = await api(`/api/stats?termId=${term.id}`, {}, apiKey);
  console.log('\n④ 完成');
  console.log(`   学期     : ${term.name}（${term.startDate} 起，共 ${term.weeks} 周）`);
  console.log(`   课程条目 : ${st.data.courseCount} 条 / 总课次 ${st.data.sessionCount} 次 / 学分 ${st.data.creditSum}`);
  console.log(`   管理界面 : ${BASE}/`);
  console.log(`   手机订阅 : ${sub.urls.subscribe}`);
  console.log(`   日程列表 : ${BASE}/api/timetable?termId=${term.id}&week=${currentWeek || 1}`);
})().catch(e => { console.error('\n导入失败：', e.message); process.exit(1); });
