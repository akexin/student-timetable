'use strict';

/**
 * 导入引擎：支持 JSON / CSV（含 Excel 另存）/ ICS（含远程订阅地址）三类数据源。
 * 数据来源可为「直接正文」「远程 URL」。
 * 冲突策略：merge（追加）/ replace（清空后导入）/ upsert（按 id 或课程指纹去重更新，默认）。
 */

const store = require('./store');
const { EXPORT_COLUMNS, parseWeeksRule, normalizeCourse, weekOfDate, courseTimeRange } = require('./model');
const { parseCSV, parseDate, toDateStr, addDays, fmtTime, parseTime, httpGet } = require('./util');

const DOW_TEXT = {
  周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6, 周日: 7, 周天: 7,
  星期一: 1, 星期二: 2, 星期三: 3, 星期四: 4, 星期五: 5, 星期六: 6, 星期日: 7, 星期天: 7,
  mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7,
};
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

function parseDayOfWeek(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v >= 1 && v <= 7 ? v : null;
  const s = String(v).trim();
  if (/^[1-7]$/.test(s)) return Number(s);
  if (DOW_TEXT[s]) return DOW_TEXT[s];
  const key = s.replace(/\s/g, '').toLowerCase();
  if (DOW_TEXT[key]) return DOW_TEXT[key];
  const m = /[星期周]\s*([一二三四五六日天])/.exec(s);
  if (m) return CN_NUM[m[1]] || null;
  return null;
}

/* ------------------------------ 目标学期解析 ------------------------------ */

function resolveTargetTerm(opts, incomingTermRaw) {
  if (opts.termId) {
    const t = store.getTermRaw(opts.termId);
    if (!t) {
      const err = new Error(`指定的 termId 不存在: ${opts.termId}`);
      err.status = 404;
      throw err;
    }
    return { term: t, created: false };
  }
  let inc = null;
  if (incomingTermRaw && typeof incomingTermRaw === 'object' && !Array.isArray(incomingTermRaw)) {
    inc = incomingTermRaw;
  }
  if (inc && inc.id && !Array.isArray(inc.id)) {
    const exists = store.getTermRaw(String(inc.id));
    if (exists) {
      store.updateTerm(exists.id, { name: inc.name, startDate: inc.startDate, weeks: inc.weeks, periods: inc.periods });
      return { term: store.getTermRaw(exists.id), created: false };
    }
  }
  if (inc && (inc.name || inc.startDate)) {
    const same = store.db.terms.find(t => t.name === inc.name && t.startDate === inc.startDate);
    if (same) return { term: same, created: false };
    const created = store.createTerm({
      name: inc.name || '导入学期',
      startDate: inc.startDate || toDateStr(new Date()),
      weeks: inc.weeks || 20,
      periods: inc.periods,
    });
    return { term: store.getTermRaw(created.id), created: true };
  }
  const cur = store.db.terms.length ? store.db.terms[store.db.terms.length - 1] : null;
  if (cur) return { term: cur, created: false };
  const auto = store.createTerm({ name: '默认学期', startDate: toDateStr(new Date()), weeks: 20 });
  return { term: store.getTermRaw(auto.id), created: true };
}

/* ------------------------------ JSON 导入 ------------------------------ */

function importJSON(text, opts) {
  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error('JSON 解析失败：' + e.message); }

  let coursesRaw = [], holidaysRaw = [], termRaw = null;
  if (Array.isArray(data)) {
    coursesRaw = data;
  } else if (data && typeof data === 'object') {
    coursesRaw = data.courses || data.data || data.timetable || [];
    if (!Array.isArray(coursesRaw)) coursesRaw = [];
    holidaysRaw = Array.isArray(data.holidays) ? data.holidays : [];
    if (data.term && typeof data.term === 'object' && !Array.isArray(data.term)) termRaw = data.term;
    if (!termRaw && Array.isArray(data.terms) && data.terms.length) termRaw = data.terms[0];
  } else {
    throw new Error('JSON 结构无法识别，期望 {term,courses,holidays} 或课程数组');
  }

  const { term, created } = resolveTargetTerm(opts, termRaw);
  const res = commit(term, coursesRaw, holidaysRaw, opts, `JSON ${coursesRaw.length} 门课程`);
  res.termCreated = created;
  return res;
}

/* ------------------------------ CSV 导入 ------------------------------ */

function headerToKey(header) {
  const h = String(header || '').trim().toLowerCase().replace(/\s/g, '');
  if (!h) return null;
  for (const col of EXPORT_COLUMNS) {
    const names = [col.header, col.key, ...col.aliases].map(x => String(x).toLowerCase().replace(/\s/g, ''));
    if (names.includes(h)) return col.key;
  }
  return null;
}

function importCSV(text, opts) {
  const rows = parseCSV(text);
  if (!rows.length) throw new Error('CSV 内容为空');
  const keys = rows[0].map(headerToKey);
  if (!keys.some(Boolean)) {
    throw new Error('CSV 表头无法识别。必需列：课程名称、星期、开始节次（或开始时间）；可选：教师、上课地点、周次规则、班级、学分、备注');
  }
  const { term, created } = resolveTargetTerm(opts, null);
  const periods = term.periods;
  const items = [];
  const rowErrors = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.length || row.every(c => String(c).trim() === '')) continue;
    const obj = {};
    keys.forEach((k, ci) => { if (k && row[ci] !== undefined) obj[k] = String(row[ci]).trim(); });
    if (!obj.name) { rowErrors.push({ row: i + 1, errors: ['缺少课程名称'] }); continue; }

    const dow = parseDayOfWeek(keys.includes('dayOfWeek') ? row[keys.indexOf('dayOfWeek')] : obj.dayOfWeek);
    if (!dow) { rowErrors.push({ row: i + 1, name: obj.name, errors: ['星期无法识别，请使用 1-7 或 周一…周日'] }); continue; }
    obj.dayOfWeek = dow;

    // 仅给出时间、未给节次时，从学期节次表反推
    if (!obj.startPeriod && obj.startTime) {
      const p = periods.find(x => x.startTime === obj.startTime);
      if (p) obj.startPeriod = p.index;
    }
    if (!obj.endPeriod && obj.endTime) {
      const p = periods.find(x => x.endTime === obj.endTime);
      if (p) obj.endPeriod = p.index;
    }
    if (!obj.startPeriod) { rowErrors.push({ row: i + 1, name: obj.name, errors: ['缺少开始节次 startPeriod，或提供可识别的开始时间 startTime'] }); continue; }
    if (obj.weeks) {
      try { obj.weeks = parseWeeksRule(obj.weeks, term.weeks); }
      catch (e) { rowErrors.push({ row: i + 1, name: obj.name, errors: [e.message] }); continue; }
    }
    items.push(obj);
  }

  const res = commit(term, items, [], opts, `CSV 共 ${rows.length - 1} 行`);
  if (rowErrors.length) { res.ok = false; res.errors = res.errors.concat(rowErrors); }
  res.termCreated = created;
  return res;
}

/* ------------------------------ ICS 导入 ------------------------------ */

function unfoldICS(text) {
  return String(text).replace(/\r?\n[ \t]/g, '');
}

function valueOf(prop) {
  // 剥离参数部分：DTSTART;TZID=X:20260907T080000 -> 20260907T080000
  const i = prop.lastIndexOf(':');
  return i < 0 ? prop : prop.slice(i + 1);
}

function dtToLocal(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(v).trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  // 注意：'T' 位于非捕获组 (?:...) 内部，因此捕获组从小时开始计数：
  //   m[1..3]=年/月/日，m[4]=时，m[5]=分，m[6]=秒（可选），m[7]=Z（可选）
  if (!m[4]) return { date, time: null };
  let hh = +m[4], mi = +m[5];
  if (m[7] === 'Z') {
    const shifted = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], hh, mi, 0) + 8 * 3600000);
    return {
      date: toDateStr(shifted),
      time: `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`,
    };
  }
  return { date, time: `${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}` };
}

function unescapeICS(s) {
  return String(s == null ? '' : s)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseICSBlocks(text) {
  const lines = unfoldICS(text).split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const up = line.toUpperCase();
    if (up === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (up === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const name = line.slice(0, i).split(';')[0].trim().toUpperCase();
    const value = line.slice(i + 1);
    cur[name] = cur[name] === undefined ? value : cur[name] + ',' + value;
  }
  return events;
}

function findPeriodByTime(periods, time, edge) {
  if (!time) return null;
  return periods.find(p => (edge === 'start' ? p.startTime : p.endTime) === time) || null;
}

function inferWeeksRule(weeks, termWeeks) {
  const list = [...new Set(weeks)].filter(w => w >= 1 && w <= termWeeks).sort((a, b) => a - b);
  const fallback = [...new Set(weeks)].filter(w => w >= 1).sort((a, b) => a - b);
  if (!fallback.length) return { mode: 'all' };
  if (!list.length) return { mode: 'list', list: fallback };
  const min = list[0], max = list[list.length - 1];
  if (max - min + 1 === list.length) {
    if (min === 1 && max === termWeeks) return { mode: 'all' };
    return { mode: 'range', start: min, end: max };
  }
  const step2 = list.every((w, i) => i === 0 || w - list[i - 1] === 2);
  if (step2) return { mode: min % 2 === 1 ? 'odd' : 'even', start: min, end: max };
  return { mode: 'list', list };
}

function importICS(text, opts) {
  const { term, created } = resolveTargetTerm(opts, null);
  const events = parseICSBlocks(text);
  if (!events.length) throw new Error('ICS 中未找到任何 VEVENT');

  const termStart = parseDate(term.startDate);
  const termEnd = addDays(termStart, term.weeks * 7 - 1);
  const items = [];
  const skipped = [];

  for (const ev of events) {
    if (!ev.DTSTART) { skipped.push({ name: ev.SUMMARY || '(无标题)', reason: '缺少 DTSTART' }); continue; }
    const s = dtToLocal(valueOf(ev.DTSTART));
    if (!s) { skipped.push({ name: ev.SUMMARY || '(无标题)', reason: 'DTSTART 无法解析' }); continue; }
    if (!s.time) { skipped.push({ name: ev.SUMMARY || '(无标题)', reason: '全天事件暂不支持导入为课程' }); continue; }

    const endhas = ev.DTEND ? dtToLocal(valueOf(ev.DTEND)) : null;
    let endTime = endhas && endhas.time ? endhas.time : fmtTime(parseTime(s.time) + 90);

    const dates = new Set([s.date]);
    if (ev.RRULE) {
      const rule = {};
      for (const seg of ev.RRULE.split(';')) {
        const idx = seg.indexOf('=');
        if (idx > 0) rule[seg.slice(0, idx).toUpperCase()] = seg.slice(idx + 1);
      }
      const freq = (rule.FREQ || 'WEEKLY').toUpperCase();
      const interval = Number(rule.INTERVAL || 1) || 1;
      let last = termEnd;
      if (rule.UNTIL) {
        const u = dtToLocal(String(rule.UNTIL).trim());
        if (u) { const d = parseDate(u.date); if (d < last) last = d; }
      }
      if (rule.COUNT) {
        const count = Number(rule.COUNT);
        if (Number.isFinite(count) && count > 0) {
          const d = addDays(parseDate(s.date), (count - 1) * interval * (freq === 'DAILY' ? 1 : 7));
          if (d < last) last = d;
        }
      }
      const step = freq === 'DAILY' ? interval : 7 * interval;
      let d = parseDate(s.date);
      let guard = 0;
      while (d <= last && guard++ < 600) {
        dates.add(toDateStr(d));
        d = addDays(d, step);
      }
    }
    for (const v of String(ev.RDATE || '').split(',').map(x => x.trim()).filter(Boolean)) {
      const dd = dtToLocal(valueOf(v));
      if (dd) dates.add(dd.date);
    }
    for (const v of String(ev.EXDATE || '').split(',').map(x => x.trim()).filter(Boolean)) {
      const dd = dtToLocal(valueOf(v));
      if (dd) dates.delete(dd.date);
    }

    const valid = [...dates]
      .filter(ds => { const d = parseDate(ds); return d >= termStart && d <= termEnd; })
      .sort();
    if (!valid.length) { skipped.push({ name: ev.SUMMARY || '(无标题)', reason: '事件不在目标学期的时间范围内' }); continue; }

    const first = parseDate(valid[0]);
    const isoDow = first.getUTCDay() === 0 ? 7 : first.getUTCDay();
    const weeks = valid.map(ds => weekOfDate(term, ds)).filter(Boolean);

    const desc = unescapeICS(ev.DESCRIPTION || '');
    const tMatch = /(?:任课教师|授课教师|主讲教师|教师|老师|Teacher)\s*[:：]\s*([^\n,;]+)/i.exec(desc);
    const cMatch = /(?:班级|行政班|Class)\s*[:：]\s*([^\n,;]+)/i.exec(desc);

    const startPeriod = findPeriodByTime(term.periods, s.time, 'start');
    const endPeriod = findPeriodByTime(term.periods, endTime, 'end');

    items.push({
      name: String(unescapeICS(ev.SUMMARY || '(未命名课程)')).trim() || '未命名课程',
      location: String(unescapeICS(ev.LOCATION || '')).trim(),
      teacher: tMatch ? tMatch[1].trim() : '',
      className: cMatch ? cMatch[1].trim() : '',
      dayOfWeek: isoDow,
      startPeriod: startPeriod ? startPeriod.index : 1,
      endPeriod: endPeriod ? endPeriod.index : (startPeriod ? startPeriod.index : 1),
      startTime: s.time,
      endTime,
      weeks: inferWeeksRule(weeks, term.weeks),
      note: desc.slice(0, 300),
    });
  }

  const res = commit(term, items, [], opts, `ICS 共 ${events.length} 个事件 → ${items.length} 门课程`);
  if (skipped.length) res.details = res.details.concat(skipped);
  res.termCreated = created;
  return res;
}

/* ------------------------------ 落库（通用） ------------------------------ */

/**
 * 课程指纹：用于 upsert 去重。
 * 关键点：startTime 必须取「节次表推导值或显式值」的归一化结果，
 * 否则同一门课一处用节次表示、另一处用时间表示时会被判为两条记录。
 */
function fingerprint(course, term) {
  let st = course.startTime || '';
  if (!st && term) {
    const range = (courseTimeRange(term, course) || {});
    st = range.startTime || '';
  }
  return [course.name, course.dayOfWeek, course.startPeriod, st, course.location || ''].join('|');
}

function commit(term, rawCourses, rawHolidays, opts, meta) {
  const mode = opts.mode || 'upsert';
  const existing = store.listCourses({ termId: term.id });
  const byId = new Map(existing.map(c => [c.id, c]));
  const byFp = new Map(existing.map(c => [fingerprint(c, term), c]));

  if (mode === 'replace') {
    store.bulkDeleteCourses(existing.map(c => c.id));
    byId.clear(); byFp.clear();
    for (const h of store.listHolidays(term.id)) store.deleteHoliday(h.id);
  }

  const errors = [], created = [], updated = [], skippedList = [];
  const seen = new Set();

  rawCourses.forEach((raw, i) => {
    const payload = { ...raw, termId: term.id };
    if (opts.applyDefaults) Object.assign(payload, opts.applyDefaults);
    let norm;
    try {
      norm = normalizeCourse(payload, { term });
    } catch (e) {
      errors.push({ index: i, name: payload.name, errors: e.errors || [e.message] });
      return;
    }
    const fp = fingerprint(norm, term);
    if (seen.has(fp)) { skippedList.push({ index: i, name: norm.name, reason: '导入数据内部重复，已忽略' }); return; }
    seen.add(fp);

    const target = norm.id && byId.has(norm.id) ? byId.get(norm.id) : byFp.get(fp);
    if (target && mode !== 'merge') {
      const upd = store.updateCourse(target.id, norm);
      updated.push(upd);
      byFp.set(fp, upd);
    } else {
      delete norm.id;
      const c = store.bulkCreateCourses([norm])[0];
      created.push(c);
      byId.set(c.id, c);
      byFp.set(fp, c);
    }
  });

  const holidays = [];
  for (const h of rawHolidays || []) {
    try { holidays.push(store.createHoliday({ ...h, termId: term.id })); }
    catch (e) { errors.push({ index: -1, name: h && h.date, errors: e.errors || [e.message] }); }
  }

  return {
    ok: errors.length === 0,
    termId: term.id,
    mode,
    source: meta || '',
    total: rawCourses.length,
    created: created.length,
    updated: updated.length,
    skipped: skippedList.length,
    holidaysImported: holidays.length,
    errors,
    details: skippedList,
    courseIds: created.concat(updated).map(c => c.id),
  };
}

/* ------------------------------ 统一入口 ------------------------------ */

function detectFormat(text) {
  const t = String(text).replace(/^[\s\uFEFF]+/, '').trim();
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  if (/^BEGIN:VCALENDAR/i.test(t)) return 'ics';
  return 'csv';
}

async function runImport(input, opts = {}) {
  let text = input.data;
  let format = opts.format && opts.format !== 'auto' ? String(opts.format).toLowerCase() : null;

  if (input.url) text = await httpGet(input.url);
  if (text === undefined || text === null) throw new Error('缺少待导入数据：请提供 data 或 url 之一');
  if (Buffer.isBuffer(text)) text = text.toString('utf8');

  if (!format) {
    const ct = input.contentType || '';
    if (/calendar/.test(ct)) format = 'ics';
    else if (/json/.test(ct)) format = 'json';
    else if (/csv|excel|spreadsheet|sheet/.test(ct)) format = 'csv';
    else format = detectFormat(text);
  }

  switch (format) {
    case 'json': return { format: 'json', ...importJSON(text, opts) };
    case 'csv': return { format: 'csv', ...importCSV(text, opts) };
    case 'ics': case 'ical': case 'icalendar': return { format: 'ics', ...importICS(text, opts) };
    default: {
      const e = new Error(`不支持的导入格式: ${format}（支持 json / csv / ics）`);
      e.status = 400;
      throw e;
    }
  }
}

module.exports = {
  runImport, importJSON, importCSV, importICS, detectFormat,
  parseDayOfWeek, inferWeeksRule, headerToKey, fingerprint,
};
