'use strict';

/**
 * 存储层：单文件 JSON 持久化（零依赖）。
 * 数据落盘采用「防抖写盘 + 同步初始化」，崩溃时最多丢失最后一次写入窗口。
 * 生产环境可替换为 MySQL/PostgreSQL，只需保持导出的方法签名一致。
 */

const fs = require('fs');
const path = require('path');
const { uid, randomToken, clone, httpGet } = require('./util');
const {
  normalizeTerm, normalizeCourse, normalizeHoliday, expandCourseOccurrences,
} = require('./model');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.TIMETABLE_DATA_DIR
  ? path.resolve(process.env.TIMETABLE_DATA_DIR)
  : path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
  apiKey: '',
  port: 3000,
  host: '0.0.0.0',
  /**
   * 生成对外订阅地址时使用的基础地址。
   * 为空时，服务端在收到请求后按 Host 头自动推断（局域网 http://192.168.x.x:3000）。
   * 小米日历需要手机可直连的地址，因此强烈建议显式配置为 https 域名或局域网 IP。
   */
  publicBaseUrl: '',
  timezone: 'Asia/Shanghai',
  /** ICS 事件默认提前提醒分钟数；0 表示不添加 VALARM */
  remindBeforeMinutes: 15,
  /** ICS 输出模式：recurrence=使用 RRULE+EXDATE（推荐订阅场景）；flat=展开为逐个事件（兼容性最强） */
  icsMode: 'recurrence',
  createdAt: new Date().toISOString(),
};

let db = null;
let config = null;
let writeTimer = null;
let writePending = false;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadConfig() {
  ensureDir();
  let cfg = { ...DEFAULT_CONFIG };
  if (fs.existsSync(CONFIG_FILE)) {
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
    catch (e) { console.warn('[store] config.json 解析失败，使用默认配置：', e.message); }
  }
  if (!cfg.apiKey) {
    cfg.apiKey = process.env.TIMETABLE_API_KEY || ('sk_' + randomToken(24));
  }
  cfg.port = Number(process.env.PORT || cfg.port || 3000);
  cfg.host = process.env.HOST || cfg.host || '0.0.0.0';
  if (process.env.TIMETABLE_PUBLIC_BASE_URL) cfg.publicBaseUrl = process.env.TIMETABLE_PUBLIC_BASE_URL;
  if (process.env.TIMETABLE_REMIND_MINUTES) cfg.remindBeforeMinutes = Number(process.env.TIMETABLE_REMIND_MINUTES);
  saveConfig(cfg);
  config = cfg;
  return cfg;
}

function saveConfig(cfg) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  config = cfg;
}

function loadDB() {
  ensureDir();
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      const bak = DB_FILE + '.corrupt.' + Date.now();
      fs.copyFileSync(DB_FILE, bak);
      console.warn('[store] db.json 损坏，已备份到 ' + bak + '，重建空库');
      db = null;
    }
  }
  if (!db || typeof db !== 'object') db = { version: 1, terms: [], courses: [], holidays: [] };
  db.terms = db.terms || [];
  db.courses = db.courses || [];
  db.holidays = db.holidays || [];
  for (const t of db.terms) {
    if (!t.subscriptionToken) t.subscriptionToken = randomToken(16);
  }
  saveDB(true);
  return db;
}

function saveDB(immediate = false) {
  ensureDir();
  writePending = true;
  if (immediate) return flushDB();
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushDB, 120);
  writeTimer.unref && writeTimer.unref();
  return true;
}

function flushDB() {
  writePending = false;
  if (!db) return;
  ensureDir();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function init() {
  loadConfig();
  loadDB();
  return { config, db };
}

/* ------------------------------ 学期 ------------------------------ */

function listTerms() { return db.terms.map(t => withTermUrls(t)); }

function getTerm(id) {
  const t = db.terms.find(x => x.id === id);
  return t ? withTermUrls(t) : null;
}

function getTermRaw(id) { return db.terms.find(x => x.id === id) || null; }

function getTermByToken(tok) {
  const t = db.terms.find(x => x.subscriptionToken === tok);
  return t || null;
}

function currentTermId() {
  if (!db.terms.length) return null;
  return db.terms[db.terms.length - 1].id;
}

function createTerm(input) {
  const t = normalizeTerm(input);
  if (!t.subscriptionToken) t.subscriptionToken = randomToken(16);
  db.terms.push(t);
  saveDB(true);
  return withTermUrls(t);
}

function updateTerm(id, patch) {
  const idx = db.terms.findIndex(x => x.id === id);
  if (idx < 0) return null;
  const merged = { ...db.terms[idx], ...patch, id };
  const t = normalizeTerm(merged, { partial: true });
  db.terms[idx] = { ...db.terms[idx], ...t, subscriptionToken: db.terms[idx].subscriptionToken };
  saveDB(true);
  return withTermUrls(db.terms[idx]);
}

function deleteTerm(id) {
  const idx = db.terms.findIndex(x => x.id === id);
  if (idx < 0) return false;
  db.terms.splice(idx, 1);
  db.courses = db.courses.filter(c => c.termId !== id);
  db.holidays = db.holidays.filter(h => h.termId !== id);
  saveDB(true);
  return true;
}

function rotateTermToken(id) {
  const t = getTermRaw(id);
  if (!t) return null;
  t.subscriptionToken = randomToken(16);
  saveDB(true);
  return withTermUrls(t);
}

function withTermUrls(t) {
  return { ...t, icsUrl: `/ics/${t.subscriptionToken}.ics`, coursesCount: db.courses.filter(c => c.termId === t.id).length };
}

/* ------------------------------ 课程 ------------------------------ */

function listCourses(filter = {}) {
  let out = db.courses.slice();
  if (filter.termId) out = out.filter(c => c.termId === filter.termId);
  if (filter.dayOfWeek) out = out.filter(c => c.dayOfWeek === Number(filter.dayOfWeek));
  if (filter.teacher) out = out.filter(c => (c.teacher || '').includes(filter.teacher));
  if (filter.q) {
    const q = String(filter.q).toLowerCase();
    out = out.filter(c => [c.name, c.teacher, c.location, c.className, c.note]
      .some(v => String(v || '').toLowerCase().includes(q)));
  }
  return out.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startPeriod - b.startPeriod);
}

function getCourse(id) { return db.courses.find(c => c.id === id) || null; }

function bulkCreateCourses(input) {
  const arr = Array.isArray(input) ? input : [input];
  const created = arr.map((raw) => {
    const term = getTermRaw(raw.termId);
    const c = normalizeCourse(raw, { term });
    db.courses.push(c);
    return c;
  });
  saveDB(true);
  return created;
}

function updateCourse(id, patch) {
  const idx = db.courses.findIndex(c => c.id === id);
  if (idx < 0) return null;
  const term = getTermRaw(db.courses[idx].termId);
  const merged = { ...db.courses[idx], ...patch, id };
  const c = normalizeCourse(merged, { term, partial: true });
  db.courses[idx] = { ...db.courses[idx], ...c };
  saveDB(true);
  return db.courses[idx];
}

function deleteCourse(id) {
  const idx = db.courses.findIndex(c => c.id === id);
  if (idx < 0) return false;
  db.courses.splice(idx, 1);
  saveDB(true);
  return true;
}

function bulkDeleteCourses(ids) {
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  const before = db.courses.length;
  db.courses = db.courses.filter(c => !set.has(c.id));
  saveDB(true);
  return before - db.courses.length;
}

/* ------------------------------ 节假日 / 调休 ------------------------------ */

function listHolidays(termId) {
  let out = db.holidays.slice();
  if (termId) out = out.filter(h => h.termId === termId);
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

function createHoliday(input) {
  const h = normalizeHoliday(input);
  db.holidays.push(h);
  saveDB(true);
  return h;
}

function updateHoliday(id, patch) {
  const idx = db.holidays.findIndex(h => h.id === id);
  if (idx < 0) return null;
  const merged = { ...db.holidays[idx], ...patch, id };
  const h = normalizeHoliday(merged, { partial: true });
  db.holidays[idx] = { ...db.holidays[idx], ...h };
  saveDB(true);
  return db.holidays[idx];
}

function deleteHoliday(id) {
  const idx = db.holidays.findIndex(h => h.id === id);
  if (idx < 0) return false;
  db.holidays.splice(idx, 1);
  saveDB(true);
  return true;
}

/* ------------------------------ 采集(远程导入) ------------------------------ */

async function fetchRemote(url) {
  return await httpGet(url);
}

/* ------------------------------ 统计 ------------------------------ */

function stats(termId) {
  const term = getTermRaw(termId);
  const courses = listCourses({ termId });
  const holidays = listHolidays(termId);
  let sessions = 0;
  const perDay = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  for (const c of courses) {
    const occ = term ? expandCourseOccurrences(term, c, holidays) : [];
    sessions += occ.length;
    perDay[c.dayOfWeek] += occ.length;
  }
  const credits = courses.reduce((s, c) => s + (Number(c.credit) || 0), 0);
  return {
    termId: termId || null,
    courseCount: courses.length,
    sessionCount: sessions,
    creditSum: Math.round(credits * 100) / 100,
    holidayCount: holidays.filter(h => h.type === 'holiday').length,
    makeupCount: holidays.filter(h => h.type === 'makeup').length,
    sessionsByDayOfWeek: perDay,
    periodsPerWeek: courses.reduce((s, c) => s + (c.weeks && c.weeks.mode === 'list' ? c.weeks.list.length : 0), 0),
  };
}

function replaceAll({ terms, courses, holidays }) {
  if (Array.isArray(terms)) db.terms = terms;
  if (Array.isArray(courses)) db.courses = courses;
  if (Array.isArray(holidays)) db.holidays = holidays;
  for (const t of db.terms) if (!t.subscriptionToken) t.subscriptionToken = randomToken(16);
  saveDB(true);
  return { terms: db.terms.length, courses: db.courses.length, holidays: db.holidays.length };
}

module.exports = {
  ROOT, DATA_DIR, DB_FILE, CONFIG_FILE,
  init, get config() { return config; }, get db() { return db; },
  saveConfig, flushDB, replaceAll,
  listTerms, getTerm, getTermRaw, getTermByToken, currentTermId, createTerm, updateTerm, deleteTerm, rotateTermToken,
  listCourses, getCourse, bulkCreateCourses, updateCourse, deleteCourse, bulkDeleteCourses,
  listHolidays, createHoliday, updateHoliday, deleteHoliday,
  fetchRemote, stats, randomToken, uid,
};
