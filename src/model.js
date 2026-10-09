'use strict';

/**
 * 数据模型层：课表字段定义（单一事实来源，文档与 JSON Schema 均由此生成）、
 * 周次规则解析与展开、课程 / 学期 / 节假日校验与规范化。
 */

const { uid, parseDate, toDateStr, parseTime, fmtTime, weekStartMonday, addDays, diffDays } = require('./util');

/* ==================================================================
 * 一、字段定义（FIELD_DEFS）
 * 说明：这是全系统唯一的字段字典，README、/api/schema、导入器、
 *      导出器全部读取它，保证文档与实现永远一致。
 * ================================================================== */

const FIELD_DEFS = {
  term: {
    id: { type: 'string', required: true, desc: '学期唯一标识，形如 term_xxxxxxxx，由服务端生成' },
    name: { type: 'string', required: true, desc: '学期名称，如 2026-2027学年 秋季学期' },
    startDate: { type: 'date', required: true, desc: '第 1 周周一（YYYY-MM-DD）。若传入非周一，自动对齐到当周周一' },
    weeks: { type: 'integer', required: true, min: 1, max: 40, default: 20, desc: '学期总周数' },
    periods: {
      type: 'array<period>', required: true, desc: '节次时间表',
      itemDef: {
        index: { type: 'integer', required: true, desc: '第几节，从 1 开始' },
        name: { type: 'string', desc: '节次名，如 第一节' },
        startTime: { type: 'time', required: true, desc: '开始时间 HH:mm' },
        endTime: { type: 'time', required: true, desc: '结束时间 HH:mm' },
      },
    },
    subscriptionToken: { type: 'string', desc: '日历订阅令牌，用于构造公开 ICS 地址（只读，由服务端生成）' },
    createdAt: { type: 'datetime', desc: '创建时间 ISO8601' },
    updatedAt: { type: 'datetime', desc: '更新时间 ISO8601' },
  },
  course: {
    id: { type: 'string', desc: '课程唯一标识；导入时留空则由服务端生成' },
    termId: { type: 'string', required: true, desc: '所属学期 id' },
    name: { type: 'string', required: true, desc: '课程名称' },
    teacher: { type: 'string', default: '', desc: '任课教师' },
    location: { type: 'string', default: '', desc: '上课地点（教室 / 实验室）' },
    dayOfWeek: { type: 'integer', required: true, min: 1, max: 7, desc: '星期几，1=周一 … 7=周日' },
    startPeriod: { type: 'integer', required: true, min: 1, desc: '开始节次，对应学期 periods.index' },
    endPeriod: { type: 'integer', min: 1, desc: '结束节次（连堂时 > startPeriod），缺省等于 startPeriod' },
    startTime: { type: 'time', desc: '可选。显式指定开始时间时覆盖节次表推导值（HH:mm）' },
    endTime: { type: 'time', desc: '可选。显式指定结束时间时覆盖节次表推导值（HH:mm）' },
    weeks: {
      type: 'weeksRule', default: { mode: 'all' }, desc:
        '上课周次规则，见 weeksRule 结构；字符串简写支持 1-16 / 1-16单 / 1-16双 / 1,3,5-9 / all',
    },
    className: { type: 'string', default: '', desc: '班级 / 行政班名称，如 计科2301' },
    credit: { type: 'number', default: null, desc: '学分' },
    note: { type: 'string', default: '', desc: '备注' },
    color: { type: 'string', default: '', desc: '显示颜色，十六进制如 #4F7CF7' },
    createdAt: { type: 'datetime', desc: '创建时间 ISO8601' },
    updatedAt: { type: 'datetime', desc: '更新时间 ISO8601' },
  },
  weeksRule: {
    mode: { type: 'enum', required: true, enum: ['all', 'odd', 'even', 'range', 'list'], desc: 'all=全周；odd=单周；even=双周；range=连续区间；list=离散列表' },
    start: { type: 'integer', desc: 'range / odd / even 的起始周' },
    end: { type: 'integer', desc: 'range / odd / even 的结束周' },
    list: { type: 'array<integer>', desc: 'mode=list 时的周次数组，如 [1,3,5]' },
  },
  holiday: {
    id: { type: 'string', desc: '记录唯一标识' },
    termId: { type: 'string', required: true, desc: '所属学期 id' },
    date: { type: 'date', required: true, desc: '日期 YYYY-MM-DD' },
    type: { type: 'enum', required: true, enum: ['holiday', 'makeup'], desc: 'holiday=放假（当日课程取消）；makeup=调休补课（当日按指定星期上课）' },
    name: { type: 'string', default: '', desc: '说明，如 国庆节 / 补周一课程' },
    targetDayOfWeek: { type: 'integer', min: 1, max: 7, desc: 'type=makeup 时生效：当日执行星期几（1-7）的课表' },
  },
};

/** 导出模板列名：CSV / Excel 表头与顺序 */
const EXPORT_COLUMNS = [
  { key: 'name', header: '课程名称', aliases: ['课程名', 'courseName', 'course', 'title', 'subject'] },
  { key: 'teacher', header: '教师', aliases: ['teacherName', 'instructor'] },
  { key: 'location', header: '上课地点', aliases: ['地点', 'place', 'room', 'classroom'] },
  { key: 'dayOfWeek', header: '星期', aliases: ['day', 'weekday', 'dow'] },
  { key: 'startPeriod', header: '开始节次', aliases: ['startPeriodIndex', 'period'] },
  { key: 'endPeriod', header: '结束节次', aliases: ['endPeriodIndex'] },
  { key: 'startTime', header: '开始时间', aliases: ['start'] },
  { key: 'endTime', header: '结束时间', aliases: ['end'] },
  { key: 'weeks', header: '周次规则', aliases: ['weeksRule', 'weekRule', 'weeksText', '周次'] },
  { key: 'className', header: '班级', aliases: ['class', '班级名'] },
  { key: 'credit', header: '学分', aliases: ['credits', 'score'] },
  { key: 'note', header: '备注', aliases: ['remark', 'comment', 'desc'] },
  { key: 'color', header: '颜色', aliases: ['colour'] },
  { key: 'id', header: '课程ID', aliases: ['courseId'] },
];

/* ==================================================================
 * 二、周次规则：解析 / 格式化 / 展开
 * ================================================================== */

/**
 * 将任意输入规范化为 weeksRule 对象。
 * 支持：'1-16'、'1-16单'、'1-16双'、'单周'、'1,3,5-9'、'all'、'*'、[1,2,3]、{mode:...}、null
 * @param {*} input
 * @param {number} termWeeks 学期总周数，用于缺省补全
 */
function parseWeeksRule(input, termWeeks = 20) {
  if (input === null || input === undefined || input === '' || input === 'all' || input === '*' || input === '全部') {
    return { mode: 'all' };
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    const mode = input.mode || (input.list ? 'list' : 'all');
    if (!['all', 'odd', 'even', 'range', 'list'].includes(mode)) throw new Error(`不支持的周次模式 "${mode}"`);
    if (mode === 'list') {
      const list = (input.list || []).map(Number).filter(n => n >= 1).sort((a, b) => a - b);
      if (!list.length) return { mode: 'all' };
      return { mode: 'list', list: [...new Set(list)] };
    }
    if (mode === 'all') return { mode: 'all' };
    const start = Number(input.start || 1), end = Number(input.end || termWeeks);
    return { mode, start: Math.min(start, end), end: Math.max(start, end) };
  }
  if (typeof input === 'number') {
    return { mode: 'list', list: [input] };
  }
  if (Array.isArray(input)) {
    const list = [...new Set(input.map(Number).filter(n => n >= 1))].sort((a, b) => a - b);
    if (!list.length) return { mode: 'all' };
    return { mode: 'list', list };
  }

  let s = String(input).trim();
  // 数字数组 "1 3 5"
  if (/^\d+(\s+\d+)*$/.test(s)) return parseWeeksRule(s.split(/\s+/).map(Number), termWeeks);

  let parity = null;
  if (/[单]/.test(s)) { parity = 'odd'; s = s.replace(/[（(]\s*单周?\s*[）)]|[单]周?/g, ''); }
  if (/[双]/.test(s)) { parity = 'even'; s = s.replace(/[（(]\s*双周?\s*[）)]|[双]周?/g, ''); }
  s = s.replace(/周/g, '').trim();

  if (s === '' || s === '-' || /^(all|全部)$/.test(s)) {
    return parity ? { mode: parity, start: 1, end: termWeeks } : { mode: 'all' };
  }

  // 解析 "1-16" 或 "1,3,5-9"
  const parts = s.split(/[,，]/).map(x => x.trim()).filter(Boolean);
  let start = Infinity, end = -Infinity;
  const singles = [];
  for (const p of parts) {
    const m = /^(\d+)\s*(?:-|-|~)\s*(\d+)$/.exec(p) || /^(\d+)\s*[-~]\s*(\d+)$/.exec(p);
    if (m) {
      start = Math.min(start, +m[1]);
      end = Math.max(end, +m[2]);
    } else if (/^\d+$/.test(p)) {
      singles.push(+p);
    } else {
      throw new Error(`无法解析周次规则 "${input}"`);
    }
  }
  if (start === Infinity && singles.length) {
    const list = [...new Set(singles)].sort((a, b) => a - b);
    return { mode: 'list', list };
  }
  if (start === Infinity) return { mode: 'all' };
  if (parity) return { mode: parity, start, end };
  return { mode: 'range', start, end };
}

/** 把离散周次压缩为区间串，如 [1,2,3,5,7,8] -> "1-3周,5周,7-8周" */
function compressWeeks(list) {
  const w = [...new Set(list)].filter(x => x >= 1).sort((a, b) => a - b);
  if (!w.length) return '';
  const out = [];
  let start = w[0], prev = w[0];
  for (let i = 1; i <= w.length; i++) {
    if (w[i] === prev + 1) { prev = w[i]; continue; }
    out.push(start === prev ? `${start}周` : `${start}-${prev}周`);
    start = prev = w[i];
  }
  return out.join(',');
}

/** 反格式化为可读中文，如 "1-16周(单)" */
function formatWeeksRule(rule, termWeeks = 20) {
  const r = rule || { mode: 'all' };
  switch (r.mode) {
    case 'all': return `1-${termWeeks}周`;
    case 'list': return compressWeeks(r.list);
    case 'odd': return r.start === r.end ? `${r.start}周(单)` : `${r.start}-${r.end}周(单)`;
    case 'even': return r.start === r.end ? `${r.start}周(双)` : `${r.start}-${r.end}周(双)`;
    case 'range': return r.start === r.end ? `${r.start}周` : `${r.start}-${r.end}周`;
    default: return '1-' + termWeeks + '周';
  }
}

/** 展开为具体周次数组 */
function expandWeeks(rule, termWeeks = 20) {
  const r = rule || { mode: 'all' };
  if (r.mode === 'list') return [...r.list];
  const out = [];
  const start = r.start || 1;
  const end = r.end || termWeeks;
  for (let w = start; w <= end; w++) {
    if (r.mode === 'all' || r.mode === 'range') out.push(w);
    else if (r.mode === 'odd' && w % 2 === 1) out.push(w);
    else if (r.mode === 'even' && w % 2 === 0) out.push(w);
  }
  return out;
}

/* ==================================================================
 * 三、默认节次表
 * ================================================================== */

const DEFAULT_PERIODS = [
  { index: 1, name: '第一节', startTime: '08:00', endTime: '08:45' },
  { index: 2, name: '第二节', startTime: '08:55', endTime: '09:40' },
  { index: 3, name: '第三节', startTime: '10:00', endTime: '10:45' },
  { index: 4, name: '第四节', startTime: '10:55', endTime: '11:40' },
  { index: 5, name: '第五节', startTime: '14:00', endTime: '14:45' },
  { index: 6, name: '第六节', startTime: '14:55', endTime: '15:40' },
  { index: 7, name: '第七节', startTime: '16:00', endTime: '16:45' },
  { index: 8, name: '第八节', startTime: '16:55', endTime: '17:40' },
  { index: 9, name: '第九节', startTime: '19:00', endTime: '19:45' },
  { index: 10, name: '第十节', startTime: '19:55', endTime: '20:40' },
];

/* ==================================================================
 * 四、校验与规范化
 * ================================================================== */

class ValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.name = 'ValidationError';
    this.errors = errors;
    this.status = 400;
  }
}

function normalizePeriods(input) {
  if (!input) return DEFAULT_PERIODS.map(p => ({ ...p }));
  if (!Array.isArray(input)) throw new ValidationError(['periods 必须是数组']);
  if (!input.length) throw new ValidationError(['periods 不能为空']);
  return input.map((p, i) => {
    const index = Number(p.index ?? i + 1);
    if (!Number.isInteger(index) || index < 1) throw new ValidationError([`periods[${i}].index 必须是 >=1 的整数`]);
    const startTime = p.startTime || p.start;
    const endTime = p.endTime || p.end;
    if (!startTime || !endTime) throw new ValidationError([`periods[${i}] 缺少 startTime / endTime`]);
    const s = parseTime(startTime), e = parseTime(endTime);
    if (e <= s) throw new ValidationError([`periods[${i}] 结束时间必须晚于开始时间`]);
    return {
      index,
      name: p.name || `第${index}节`,
      startTime: fmtTime(s),
      endTime: fmtTime(e),
    };
  }).sort((a, b) => a.index - b.index);
}

/**
 * 规范化学期。partial=true 用于 PATCH/PUT 局部更新。
 */
function normalizeTerm(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object') throw new ValidationError(['请求体必须是 JSON 对象']);
  const errors = [];
  const now = new Date().toISOString();
  const out = input.id ? { id: String(input.id) } : {};
  if (!partial && !input.id) out.id = uid('term');

  if (input.name !== undefined) out.name = String(input.name).trim();
  if (!partial && !out.name) errors.push('缺少必填字段 name');

  if (input.startDate !== undefined) {
    const d = parseDate(input.startDate);
    const mon = weekStartMonday(d);
    out.startDate = toDateStr(mon);
    if (toDateStr(d) !== out.startDate) {
      out._startDateAutoAligned = toDateStr(d); // 供上层提示：已自动对齐到周一
    }
  }
  if (!partial && !out.startDate) errors.push('缺少必填字段 startDate');

  if (input.weeks !== undefined) {
    const w = Number(input.weeks);
    if (!Number.isInteger(w) || w < 1 || w > 40) errors.push('weeks 必须是 1-40 的整数');
    else out.weeks = w;
  }
  if (!partial && out.weeks === undefined) out.weeks = 20;

  if (input.periods !== undefined) {
    try { out.periods = normalizePeriods(input.periods); }
    catch (e) { errors.push(...(e.errors || [e.message])); }
  }
  if (!partial && !out.periods) out.periods = DEFAULT_PERIODS.map(p => ({ ...p }));

  out.updatedAt = now;
  if (!partial) out.createdAt = input.createdAt || now;
  if (input.subscriptionToken) out.subscriptionToken = String(input.subscriptionToken);

  if (errors.length) throw new ValidationError(errors);
  return out;
}

/**
 * 规范化课程。
 * @param {object} input
 * @param {object} ctx { term, partial }
 */
function normalizeCourse(input, ctx = {}) {
  const { term = null, partial = false } = ctx;
  if (!input || typeof input !== 'object') throw new ValidationError(['请求体必须是 JSON 对象']);
  const errors = [];
  const now = new Date().toISOString();
  const termWeeks = (term && term.weeks) || 20;
  const periods = (term && term.periods) || DEFAULT_PERIODS;

  const out = input.id ? { id: String(input.id) } : {};
  if (!partial && !input.id) out.id = uid('c');

  if (input.termId !== undefined) out.termId = String(input.termId);
  if (!partial && !out.termId) errors.push('缺少必填字段 termId');

  if (input.name !== undefined) {
    const n = String(input.name).trim();
    if (!n) errors.push('name 不能为空'); else out.name = n;
  }
  if (!partial && out.name === undefined) errors.push('缺少必填字段 name');

  for (const k of ['teacher', 'location', 'className', 'note', 'color']) {
    if (input[k] !== undefined) out[k] = String(input[k] ?? '').trim();
  }
  if (!partial) {
    out.teacher = out.teacher ?? '';
    out.location = out.location ?? '';
    out.className = out.className ?? '';
    out.note = out.note ?? '';
    out.color = out.color ?? '';
  }

  if (input.dayOfWeek !== undefined) {
    const d = Number(input.dayOfWeek);
    if (!Number.isInteger(d) || d < 1 || d > 7) errors.push('dayOfWeek 必须是 1-7 的整数（1=周一）');
    else out.dayOfWeek = d;
  }
  if (!partial && out.dayOfWeek === undefined) errors.push('缺少必填字段 dayOfWeek（1=周一 … 7=周日）');

  if (input.startPeriod !== undefined) {
    const p = Number(input.startPeriod);
    if (!Number.isInteger(p) || p < 1) errors.push('startPeriod 必须是 >=1 的整数');
    else out.startPeriod = p;
  }
  if (input.endPeriod !== undefined) {
    const p = Number(input.endPeriod);
    if (!Number.isInteger(p) || p < 1) errors.push('endPeriod 必须是 >=1 的整数');
    else out.endPeriod = p;
  }
  if (out.startPeriod !== undefined) {
    if (out.endPeriod === undefined) out.endPeriod = input.endPeriod !== undefined ? Number(input.endPeriod) : out.startPeriod;
    if (out.endPeriod < out.startPeriod) errors.push('endPeriod 必须 >= startPeriod');
  }
  if (!partial && out.startPeriod === undefined) errors.push('缺少必填字段 startPeriod');

  for (const [k, label] of [['startTime', 'startTime'], ['endTime', 'endTime']]) {
    if (input[k] !== undefined && input[k] !== '' && input[k] !== null) {
      try { out[k] = fmtTime(parseTime(input[k])); }
      catch (e) { errors.push(`${label} 格式应为 HH:mm`); }
    }
  }

  if (input.weeks !== undefined) {
    try { out.weeks = parseWeeksRule(input.weeks, termWeeks); }
    catch (e) { errors.push(e.message); }
  }
  if (!partial && out.weeks === undefined) out.weeks = { mode: 'all' };

  if (input.credit !== undefined && input.credit !== '' && input.credit !== null) {
    const c = Number(input.credit);
    if (Number.isNaN(c)) errors.push('credit 必须是数字'); else out.credit = c;
  }
  if (!partial && out.credit === undefined) out.credit = null;

  // 上限校验：节次必须存在于该学期节次表中（允许额外节次时给出提示而非报错）
  if (out.startPeriod !== undefined && periods.length && out.startPeriod > periods.length && !out.startTime) {
    errors.push(`startPeriod=${out.startPeriod} 超出学期节次表范围（共 ${periods.length} 节），请补充 startTime / endTime 或扩展学期节次表`);
  }

  out.updatedAt = now;
  if (!partial) out.createdAt = input.createdAt || now;

  if (errors.length) throw new ValidationError(errors);
  return out;
}

/** 规范化节假日 / 调休记录 */
function normalizeHoliday(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object') throw new ValidationError(['请求体必须是 JSON 对象']);
  const errors = [];
  const out = input.id ? { id: String(input.id) } : {};
  if (!partial && !input.id) out.id = uid('h');

  if (input.termId !== undefined) out.termId = String(input.termId);
  if (!partial && !out.termId) errors.push('缺少必填字段 termId');

  if (input.date !== undefined) {
    try { out.date = toDateStr(parseDate(input.date)); }
    catch (e) { errors.push(e.message); }
  }
  if (!partial && !out.date) errors.push('缺少必填字段 date');

  if (input.type !== undefined) {
    const t = String(input.type);
    if (!['holiday', 'makeup'].includes(t)) errors.push('type 必须是 holiday（放假）或 makeup（调休补课）');
    else out.type = t;
  }
  if (!partial && !out.type) errors.push('缺少必填字段 type');

  if (input.targetDayOfWeek !== undefined && input.targetDayOfWeek !== '' && input.targetDayOfWeek !== null) {
    const d = Number(input.targetDayOfWeek);
    if (!Number.isInteger(d) || d < 1 || d > 7) errors.push('targetDayOfWeek 必须是 1-7');
    else out.targetDayOfWeek = d;
  }
  if (out.type === 'makeup' && out.targetDayOfWeek === undefined) {
    errors.push('type=makeup 时必须提供 targetDayOfWeek（当日执行星期几的课表）');
  }
  if (out.type === 'holiday') out.targetDayOfWeek = null;

  if (input.name !== undefined) out.name = String(input.name).trim();
  if (!partial && out.name === undefined) out.name = '';

  if (errors.length) throw new ValidationError(errors);
  return out;
}

/* ==================================================================
 * 五、派生数据：日期 / 上课实例展开
 * ================================================================== */

/** 学期某周的周一 */
function weekMonday(term, weekNo) {
  return addDays(parseDate(term.startDate), (weekNo - 1) * 7);
}

/** 计算某日期处于学期第几周（超出范围返回 null） */
function weekOfDate(term, date) {
  const d = typeof date === 'string' ? parseDate(date) : date;
  const delta = diffDays(d, parseDate(term.startDate));
  if (delta < 0) return null;
  return Math.floor(delta / 7) + 1;
}

/** 取学期中第 index 节的时间 {startTime,endTime}（分钟数 ↔ HH:mm） */
function periodTime(term, index) {
  const p = ((term && term.periods) || DEFAULT_PERIODS).find(x => x.index === index);
  return p || null;
}

/**
 * 解析一门课在某天的实际上课时间段。
 * 优先级：课程显式 startTime/endTime > 学期节次表（跨多节时取首节开始到末节结束）
 */
function courseTimeRange(term, course) {
  let start = course.startTime, end = course.endTime;
  if (!start || !end) {
    const a = periodTime(term, course.startPeriod);
    const b = periodTime(term, course.endPeriod || course.startPeriod);
    if (!a || !b) {
      if (!start || !end) return null;
      return { startTime: start, endTime: end, resolved: false };
    }
    start = start || a.startTime;
    end = end || b.endTime;
  }
  return { startTime: start, endTime: end, resolved: true };
}

/**
 * 将课程展开为具体上课日期列表（已应用节假日与调休规则）。
 * @returns {Array<{date:string,week:number,startTime:string,endTime:string}>}
 */
function expandCourseOccurrences(term, course, holidays = []) {
  const termWeeks = term.weeks || 20;
  const weeks = expandWeeks(course.weeks, termWeeks).filter(w => w >= 1 && w <= termWeeks);
  const range = courseTimeRange(term, course);
  if (!range) return [];

  const holidaySet = new Set(holidays.filter(h => h.type === 'holiday').map(h => h.date));
  const makeups = holidays.filter(h => h.type === 'makeup');

  const out = [];
  for (const w of weeks) {
    const dateObj = addDays(weekMonday(term, w), course.dayOfWeek - 1);
    const ds = toDateStr(dateObj);
    if (holidaySet.has(ds)) continue; // 放假：当日课程取消
    out.push({ date: ds, week: w, startTime: range.startTime, endTime: range.endTime });
  }

  // 调休补课：当日执行 targetDayOfWeek 的课表
  for (const mk of makeups) {
    const target = mk.targetDayOfWeek;
    if (!target) continue;
    const thisWeek = weekOfDate(term, mk.date);
    const matchWeek = thisWeek !== null && weeks.includes(thisWeek);
    if (target !== course.dayOfWeek) continue;
    if (!matchWeek) continue; // 该课程本周本就不上课
    if (holidaySet.has(mk.date)) continue;
    if (out.some(o => o.date === mk.date)) continue;
    out.push({ date: mk.date, week: thisWeek, startTime: range.startTime, endTime: range.endTime, makeup: true });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 生成 JSON Schema（用于 /api/schema 与外部系统对接） */
function buildJsonSchema() {
  const map = (def) => {
    const props = {}, required = [];
    for (const [k, v] of Object.entries(def)) {
      required.push(k);
      if (v.type === 'string') props[k] = { type: 'string', description: v.desc };
      else if (v.type === 'date') props[k] = { type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: v.desc };
      else if (v.type === 'time') props[k] = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: v.desc };
      else if (v.type === 'datetime') props[k] = { type: 'string', format: 'date-time', description: v.desc };
      else if (v.type === 'integer') props[k] = { type: 'integer', description: v.desc, ...(v.min !== undefined ? { minimum: v.min } : {}), ...(v.max !== undefined ? { maximum: v.max } : {}) };
      else if (v.type === 'number') props[k] = { type: 'number', description: v.desc };
      else if (v.type === 'enum') props[k] = { type: 'string', enum: v.enum, description: v.desc };
      else if (v.type === 'array<integer>') props[k] = { type: 'array', items: { type: 'integer' }, description: v.desc };
      else if (v.type === 'weeksRule') props[k] = { $ref: '#/definitions/weeksRule', description: v.desc };
      else props[k] = { description: v.desc };
      if (v.default !== undefined) props[k].default = v.default;
    }
    return { type: 'object', properties: props, required };
  };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'StudentTimetable',
    definitions: {
      weeksRule: map(FIELD_DEFS.weeksRule),
      period: {
        type: 'object',
        required: ['index', 'startTime', 'endTime'],
        properties: {
          index: { type: 'integer', minimum: 1, description: FIELD_DEFS.term.periods.itemDef.index.desc },
          name: { type: 'string', description: FIELD_DEFS.term.periods.itemDef.name.desc },
          startTime: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: FIELD_DEFS.term.periods.itemDef.startTime.desc },
          endTime: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: FIELD_DEFS.term.periods.itemDef.endTime.desc },
        },
      },
    },
    properties: {
      term: map(FIELD_DEFS.term),
      course: map(FIELD_DEFS.course),
      holiday: map(FIELD_DEFS.holiday),
      period: { $ref: '#/definitions/period' },
    },
  };
}

module.exports = {
  FIELD_DEFS,
  EXPORT_COLUMNS,
  DEFAULT_PERIODS,
  ValidationError,
  parseWeeksRule, formatWeeksRule, expandWeeks, compressWeeks,
  normalizeTerm, normalizeCourse, normalizeHoliday, normalizePeriods,
  weekMonday, weekOfDate, periodTime, courseTimeRange, expandCourseOccurrences,
  buildJsonSchema,
};
