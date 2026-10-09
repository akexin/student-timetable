'use strict';

/**
 * 导出引擎：统一把内部数据渲染为 JSON / CSV / XLSX / ICS 四种格式。
 * 所有导出共享同一套「扁平化」逻辑，保证不同格式之间信息等价。
 */

const store = require('./store');
const { EXPORT_COLUMNS, formatWeeksRule, expandCourseOccurrences, courseTimeRange } = require('./model');
const { buildICS } = require('./ics');
const { buildXlsx } = require('./xlsx');
const { toCSV } = require('./util');

const DOW_LABEL = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function dayLabel(d) { return DOW_LABEL[d] || String(d); }

/** 组装包含学期、课程、节假日的完整数据对象（JSON 导出与互导出的公共结构） */
function buildPayload(termId, opts = {}) {
  const term = store.getTermRaw(termId);
  if (!term) return null;
  const courses = store.listCourses({ termId });
  const holidays = store.listHolidays(termId);
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    generator: 'student-timetable-system/1.0',
    term: {
      id: term.id,
      name: term.name,
      startDate: term.startDate,
      weeks: term.weeks,
      periods: term.periods,
      subscriptionToken: term.subscriptionToken,
    },
    courses: courses.map(c => {
      const range = courseTimeRange(term, c);
      const base = {
        id: c.id,
        termId: c.termId,
        name: c.name,
        teacher: c.teacher,
        location: c.location,
        dayOfWeek: c.dayOfWeek,
        dayLabel: dayLabel(c.dayOfWeek),
        startPeriod: c.startPeriod,
        endPeriod: c.endPeriod || c.startPeriod,
        weeks: c.weeks,
        weeksText: formatWeeksRule(c.weeks, term.weeks),
        className: c.className,
        credit: c.credit,
        note: c.note,
        color: c.color,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
      if (range) { base.startTime = range.startTime; base.endTime = range.endTime; }
      if (opts.includeOccurrences) {
        base.occurrences = expandCourseOccurrences(term, c, holidays);
      }
      return base;
    }),
    holidays,
  };
  return payload;
}

/** 扁平化 CSV 行 */
function toFlatRows(term, courses) {
  return courses.map(c => {
    const range = courseTimeRange(term, c);
    return EXPORT_COLUMNS.map(col => {
      switch (col.key) {
        case 'dayOfWeek': return dayLabel(c.dayOfWeek);
        case 'startPeriod': return c.startPeriod;
        case 'endPeriod': return c.endPeriod || c.startPeriod;
        case 'weeks': return formatWeeksRule(c.weeks, term.weeks);
        case 'startTime': return range ? range.startTime : '';
        case 'endTime': return range ? range.endTime : '';
        case 'credit': return c.credit === null || c.credit === undefined ? '' : c.credit;
        default: return c[col.key] === null || c[col.key] === undefined ? '' : c[col.key];
      }
    });
  });
}

function exportJSON(termId, opts = {}) {
  const payload = buildPayload(termId, opts);
  if (!payload) return null;
  const body = opts.pretty === false
    ? JSON.stringify(payload)
    : JSON.stringify(payload, null, 2);
  return { body, contentType: 'application/json; charset=utf-8', filename: `${payload.term.name || 'timetable'}.json` };
}

function exportCSV(termId) {
  const term = store.getTermRaw(termId);
  if (!term) return null;
  const courses = store.listCourses({ termId });
  const rows = [EXPORT_COLUMNS.map(c => c.header)];
  rows.push(...toFlatRows(term, courses));
  const safe = (term.name || 'timetable').replace(/[\\/:*?"<>|]/g, '_');
  return {
    body: toCSV(rows),
    contentType: 'text/csv; charset=utf-8',
    filename: `${safe}.csv`,
  };
}

/**
 * 导出「周视图矩阵」CSV：行=节次，列=星期，便于直接打印张贴。
 */
function exportCSVGrid(termId) {
  const term = store.getTermRaw(termId);
  if (!term) return null;
  const courses = store.listCourses({ termId });
  const rows = [[`${term.name} 课表`].concat(Array(6).fill(''))];
  rows.push(['节次'].concat(DOW_LABEL.slice(1)));
  for (const p of term.periods) {
    const cells = [p.name ? `${p.name}\n${p.startTime}-${p.endTime}` : `${p.startTime}-${p.endTime}`];
    for (let d = 1; d <= 7; d++) {
      const hit = courses.filter(c => c.dayOfWeek === d && c.startPeriod <= p.index && (c.endPeriod || c.startPeriod) >= p.index);
      cells.push(hit.map(c => `${c.name}${c.location ? '\n@' + c.location : ''}${c.weeks && c.weeks.mode !== 'all' ? '\n(' + formatWeeksRule(c.weeks, term.weeks) + ')' : ''}`).join('\n\n'));
    }
    rows.push(cells);
  }
  const safe = (term.name || 'timetable').replace(/[\\/:*?"<>|]/g, '_');
  return { body: toCSV(rows), contentType: 'text/csv; charset=utf-8', filename: `${safe}-周视图.csv` };
}

function exportXlsx(termId) {
  const term = store.getTermRaw(termId);
  if (!term) return null;
  const courses = store.listCourses({ termId });
  const columns = EXPORT_COLUMNS.map(c => ({ header: c.header, width: c.key === 'name' ? 24 : c.key === 'location' ? 18 : c.key === 'weeks' ? 16 : 12 }));
  const periodSheet = {
    name: '学期与节次',
    columns: [{ header: '项目', width: 20 }, { header: '值', width: 36 }],
    rows: [
      ['学期名称', term.name],
      ['学期ID', term.id],
      ['第一周周一', term.startDate],
      ['总周数', term.weeks],
      ['课程数', courses.length],
      ['导出时间', new Date().toISOString()],
      [],
      ['节次', '时间安排'],
      ...term.periods.map(p => [p.name || `第${p.index}节`, `${p.startTime} - ${p.endTime}`]),
    ],
    freezeHeader: true,
  };
  const holidayRows = store.listHolidays(termId).map(h => [h.date, h.type === 'holiday' ? '放假' : '调休补课', h.targetDayOfWeek ? dayLabel(h.targetDayOfWeek) : '', h.name]);
  const buf = buildXlsx([
    { name: '课表', columns, rows: toFlatRows(term, courses), freezeHeader: true },
    {
      name: '节假调休',
      columns: [{ header: '日期', width: 14 }, { header: '类型', width: 12 }, { header: '执行星期', width: 12 }, { header: '说明', width: 24 }],
      rows: holidayRows.length ? holidayRows : [['（无）', '', '', '']],
      freezeHeader: true,
    },
    periodSheet,
  ]);
  const safe = (term.name || 'timetable').replace(/[\\/:*?"<>|]/g, '_');
  return {
    body: buf,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: `${safe}.xlsx`,
  };
}

/** 直接由原始二维表生成 xlsx（模板下载等场景） */
function exportXlsxWithRows(rows, freezeHeader = true) {
  const columns = (rows[0] || []).map(h => ({ header: String(h), width: String(h).length > 6 ? 22 : 14 }));
  const body = rows.slice(1);
  const buf = buildXlsx([{ name: '课表', columns, rows: body, freezeHeader }]);
  return buf;
}

function exportICS(termId, opts = {}) {
  const term = store.getTermRaw(termId);
  if (!term) return null;
  const cfg = store.config;
  const courses = store.listCourses({ termId });
  const holidays = store.listHolidays(termId);
  const text = buildICS({
    term, courses, holidays,
    mode: opts.mode || cfg.icsMode || 'recurrence',
    remindBeforeMinutes: opts.remindBeforeMinutes !== undefined ? Number(opts.remindBeforeMinutes) : (cfg.remindBeforeMinutes ?? 15),
    tz: opts.tz || 'floating',
    timezone: cfg.timezone || 'Asia/Shanghai',
    titleTemplate: opts.titleTemplate || '{name}',
    domain: (opts.domain || 'timetable.local'),
  });
  const fnMode = (opts.mode || cfg.icsMode || 'recurrence') === 'flat' ? 'flat' : 'recur';
  return {
    body: Buffer.from(text, 'utf8'),
    contentType: 'text/calendar; charset=utf-8; component=vevent; method=PUBLISH',
    filename: `timetable-${term.id}-${fnMode}.ics`,
    text,
  };
}

module.exports = { buildPayload, toFlatRows, exportJSON, exportCSV, exportCSVGrid, exportXlsx, exportXlsxWithRows, exportICS, dayLabel, DOW_LABEL };
