'use strict';

/**
 * iCalendar (RFC5545) 生成器，专门针对国内高校教务数据与小米日历做过兼容性处理。
 *
 * 兼容性关键决策：
 *  1. 默认输出 floating local time（不带 TZID/VTIMEZONE）。多数国产手机
 *     （含小米）日历 App 的 TZID 解析实现不完整，可能出现 ±8 小时偏移；
 *     浮动时间配合手机本地时区即可正确显示。需要严格符合 RFC 的场景
 *     可通过 tz=tzid 打开 VTIMEZONE + TZID 模式。
 *  2. 行尾固定 CRLF，内容行按 75 字节折叠（UTF-8 安全切分），首行内容包括
 *     VCALENDAR 均符合 RFC5545 §3.1 要求。
 *  3. UID 稳定不变（幂等），订阅端刷新时不会产生重复事件，也不会重建提醒。
 *  4. 提供 recurrence（RRULE+EXDATE，体积小、适合长期订阅）与
 *     flat（逐条事件，兼容性最强）两种输出模式。
 */

const { expandCourseOccurrences, formatWeeksRule, expandWeeks } = require('./model');
const { DOW_ICS, toDateStr, addDays, parseDate } = require('./util');

/* ------------------------------ 文本处理 ------------------------------ */

function escapeText(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC5545 折叠：按 UTF-8 字节计，每行不超过 75 字节，续行以单个空格开头 */
function foldLine(line) {
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= 75) return line;
  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < buf.length) {
    if (buf.length - start <= limit) { parts.push(buf.slice(start)); break; }
    let cut = start + limit;
    while (cut > start && (buf[cut] & 0xc0) === 0x80) cut--;
    parts.push(buf.slice(start, cut));
    start = cut;
    limit = 74; // 续行前缀占用一个空格
  }
  return parts.map((b, i) => (i === 0 ? b : Buffer.concat([Buffer.from(' '), b])).toString('utf8')).join('\r\n');
}

/* ------------------------------ 时间转换 ------------------------------ */

function localDT(dateStr, timeStr) {
  return `${dateStr.replace(/-/g, '')}T${timeStr.replace(':', '')}00`;
}

function tzOffsetMinutes(tz, ts) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const o = {};
    for (const p of dtf.formatToParts(new Date(ts))) o[p.type] = p.value;
    const asUTC = Date.UTC(+o.year, +o.month - 1, +o.day, (+o.hour) % 24, +o.minute, +o.second);
    return (asUTC - Math.floor(ts / 1000) * 1000) / 60000;
  } catch (e) {
    return 480; // 回退：UTC+8
  }
}

function zonedToUTC(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mi] = timeStr.split(':').map(Number);
  let ts = Date.UTC(y, m - 1, d, hh, mi, 0);
  let off = tzOffsetMinutes(tz, ts);
  ts -= off * 60000;
  const off2 = tzOffsetMinutes(tz, ts);
  if (off2 !== off) ts -= (off2 - off) * 60000;
  return new Date(ts);
}

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function isoToStamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? utcStamp(new Date()) : utcStamp(d);
}

function vtimezone(tz) {
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${tz}`,
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
}

/* ------------------------------ 标题模板 ------------------------------ */

function resolveTemplate(tpl, course) {
  const map = {
    name: course.name || '',
    teacher: course.teacher || '',
    location: course.location || '',
    room: course.location || '',
    class: course.className || '',
    className: course.className || '',
    note: course.note || '',
  };
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (map[k] !== undefined ? map[k] : m));
}

/* ------------------------------ 主构建函数 ------------------------------ */

/**
 * @param {object} opts
 * @param {object} opts.term   学期
 * @param {Array}  opts.courses 课程
 * @param {Array}  opts.holidays 节假日/调休
 * @param {'recurrence'|'flat'} [opts.mode]
 * @param {number} [opts.remindBeforeMinutes] 0 表示不生成 VALARM
 * @param {'floating'|'tzid'} [opts.tz]
 * @param {string} [opts.timezone]
 * @param {string} [opts.domain] UID 域
 * @param {string} [opts.titleTemplate]
 * @param {boolean}[opts.includeAlarm]
 * @returns {string} ICS 文本（CRLF 行尾）
 */
function buildICS(opts) {
  const {
    term, courses = [], holidays = [],
    mode = 'recurrence',
    remindBeforeMinutes = 15,
    tz = 'floating',
    timezone = 'Asia/Shanghai',
    domain = 'timetable.local',
    titleTemplate = '{name}',
  } = opts;

  const lines = [];
  const calName = `${term.name} 课表`;
  lines.push(
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WorkBuddy//StudentTimetable 1.0//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calName)}`,
    `X-WR-TIMEZONE:${timezone}`,
    `X-WR-CALDESC:${escapeText(`${term.name} 自动同步课表，共 ${courses.length} 门课程`)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  );
  if (tz === 'tzid') lines.push(...vtimezone(timezone));

  const dtPrefix = (start) => {
    const key = tz === 'tzid' ? `DTSTART;TZID=${timezone}` : 'DTSTART';
    return key + ':' + localDT.apply(null, start);
  };
  const dtEndKey = tz === 'tzid' ? `DTEND;TZID=${timezone}` : 'DTEND';

  for (const course of courses) {
    const occurrences = expandCourseOccurrences(term, course, holidays);
    if (!occurrences.length) continue;
    const title = resolveTemplate(titleTemplate, course);
    const descParts = [
      `课程:${course.name}`,
      course.teacher ? `教师:${course.teacher}` : null,
      course.className ? `班级:${course.className}` : null,
      `周次:${formatWeeksRule(course.weeks, term.weeks)}`,
      `节次:第${course.startPeriod}${course.endPeriod && course.endPeriod !== course.startPeriod ? '-' + course.endPeriod : ''}节`,
      course.location ? `地点:${course.location}` : null,
      course.credit ? `学分:${course.credit}` : null,
      course.note ? `备注:${course.note}` : null,
    ].filter(Boolean);
    const description = descParts.join('\n');
    const dtStamp = isoToStamp(course.updatedAt || course.createdAt);
    const uidBase = `${course.id}@${domain}`;

    const alarmBlock = (remindBeforeMinutes > 0)
      ? ['BEGIN:VALARM', `TRIGGER:-PT${remindBeforeMinutes}M`, 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(`上课提醒:${course.name}`)}`, 'END:VALARM']
      : [];

    if (mode === 'flat') {
      for (const occ of occurrences) {
        lines.push(
          'BEGIN:VEVENT',
          `UID:${uidBase}-${occ.date.replace(/-/g, '')}`,
          `DTSTAMP:${dtStamp}`,
          dtPrefix([occ.date, occ.startTime]),
          `${dtEndKey}:${localDT(occ.date, occ.endTime)}`,
          `SUMMARY:${escapeText(title)}`,
          `LOCATION:${escapeText(course.location)}`,
          `DESCRIPTION:${escapeText(description)}`,
          'TRANSP:OPAQUE',
          'STATUS:CONFIRMED',
          'SEQUENCE:0',
          ...alarmBlock,
          'END:VEVENT',
        );
      }
      continue;
    }

    /* -------- recurrence 模式：RRULE + EXDATE + 调休单实例 -------- */
    const regular = occurrences.filter(o => !o.makeup);
    const makeup = occurrences.filter(o => o.makeup);

    if (regular.length) {
      const first = regular[0];
      const last = regular[regular.length - 1];
      const regularSet = new Set(regular.map(o => o.date));

      // 用最大公约数求基础重复步长（同一星期几 → 步长恒为 7 的倍数）
      const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
      const steps = [];
      for (let i = 1; i < regular.length; i++) {
        steps.push(Math.round((parseDate(regular[i].date) - parseDate(regular[i - 1].date)) / 86400000));
      }
      const baseStep = steps.length ? steps.reduce((g, s) => gcd(g, s), steps[0]) : 7;
      let rruleLine = null;
      let rruleEnd = last.date;

      if (regular.length > 1 && baseStep >= 7 && baseStep % 7 === 0) {
        const interval = Math.max(1, Math.round(baseStep / 7));
        const parts = ['FREQ=WEEKLY', `INTERVAL=${interval}`, `BYDAY=${DOW_ICS[course.dayOfWeek % 7]}`];
        parts.push(tz === 'tzid'
          ? `UNTIL=${utcStamp(zonedToUTC(last.date, last.endTime, timezone))}`
          : `UNTIL=${localDT(last.date, last.endTime)}`);
        rruleLine = parts.join(';');
      }

      lines.push(
        'BEGIN:VEVENT',
        `UID:${uidBase}`,
        `DTSTAMP:${dtStamp}`,
        dtPrefix([first.date, first.startTime]),
        `${dtEndKey}:${localDT(first.date, first.endTime)}`,
      );
      if (rruleLine) lines.push(`RRULE:${rruleLine}`);
      lines.push(
        `SUMMARY:${escapeText(title)}`,
        `LOCATION:${escapeText(course.location)}`,
        `DESCRIPTION:${escapeText(description)}`,
        'TRANSP:OPAQUE',
        'STATUS:CONFIRMED',
        'SEQUENCE:0',
      );

      // 放假剔除：RRULE 会产生、但实际不上课的日期，一律写入 EXDATE
      const exdates = [];
      if (rruleLine) {
        const endDate = parseDate(rruleEnd);
        let d = addDays(parseDate(first.date), baseStep);
        let guard = 0;
        while (d <= endDate && guard++ < 600) {
          const ds = toDateStr(d);
          if (!regularSet.has(ds) && !makeup.some(m => m.date === ds)) exdates.push(ds);
          d = addDays(d, baseStep);
        }
      }
      if (exdates.length) {
        const vals = exdates.map(x => localDT(x, first.startTime));
        lines.push(foldLine(`EXDATE${tz === 'tzid' ? `;TZID=${timezone}` : ''}:${vals.join(',')}`));
      }
      lines.push(...alarmBlock, 'END:VEVENT');
    }

    // 调休补课：单独的单次事件，UID 带日期后缀保持稳定
    for (const occ of makeup) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${uidBase}-mk-${occ.date.replace(/-/g, '')}`,
        `DTSTAMP:${dtStamp}`,
        dtPrefix([occ.date, occ.startTime]),
        `${dtEndKey}:${localDT(occ.date, occ.endTime)}`,
        `SUMMARY:${escapeText(title)}`,
        `LOCATION:${escapeText(course.location)}`,
        `DESCRIPTION:${escapeText(description + '\n[调休补课]')}`,
        'TRANSP:OPAQUE',
        'STATUS:CONFIRMED',
        'SEQUENCE:0',
        ...alarmBlock,
        'END:VEVENT',
      );
    }
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** 统计 ICS 中的 VEVENT 数量，供导出响应回显 */
function countEvents(ics) {
  return (ics.match(/BEGIN:VEVENT/g) || []).length;
}

module.exports = { buildICS, countEvents, escapeText, foldLine };
