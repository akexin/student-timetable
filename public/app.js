/* 学生课表系统 —— Web 管理端
 * 纯原生 JS，无任何第三方依赖，通过 REST API 与后端交互。 */

const KEY_STORAGE = 'stt_apikey';
const ROW_H = 60;               // 每行（节次）高度 px
const PALETTE = ['#4F7CF7', '#7C5CFF', '#17B26A', '#F79009', '#EE46BC', '#0BA5EC', '#F04438', '#12B76A', '#DD2590', '#84CAFF'];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  key: '',
  terms: [],
  termId: null,
  week: 1,
  data: null,      // /api/timetable 结果
  stats: null,
  holidays: [],
  /** grid=周课表网格（宽屏） / agenda=日程列表（窄屏与手机默认） */
  view: (typeof window !== 'undefined' && window.innerWidth < 760) ? 'agenda' : 'grid',
};

/* ============================ 通用 ============================ */

function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.className = 'toast'; }, 2600);
}

function banner(msg, err) {
  const b = $('#banner');
  if (!msg) { b.className = 'banner hidden'; return; }
  b.innerHTML = msg;
  b.className = 'banner' + (err ? ' err' : '');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': state.key, ...(opts.headers || {}) },
  });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) return { _raw: res };
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.error || json.message || ('HTTP ' + res.status);
    throw Object.assign(new Error(msg), { payload: json });
  }
  return json;
}

function openModal(id) {
  $('#mask').classList.add('show');
  $(id).classList.add('show');
}
function closeModals() {
  $('#mask').classList.remove('show');
  $$('.modal').forEach(m => m.classList.remove('show'));
}
$$('[data-close]').forEach(b => b.addEventListener('click', closeModals));
$('#mask').addEventListener('click', closeModals);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });

function downloadBlob(buf, filename, contentType) {
  const url = URL.createObjectURL(new Blob([buf], { type: contentType }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ============================ 数据加载 ============================ */

async function loadTerms() {
  const r = await api('/api/terms');
  state.terms = r.items || [];
  const sel = $('#termSelect');
  sel.innerHTML = state.terms.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  if (!state.termId || !state.terms.some(t => t.id === state.termId)) {
    state.termId = state.terms.length ? state.terms[0].id : null;
  }
  sel.value = state.termId || '';
  $('#f_importTerm').innerHTML = state.terms.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('') + '<option value="">（自动新建学期）</option>';
  $('#f_importTerm').value = state.termId || '';
}

async function loadWeekSelect() {
  const term = state.terms.find(t => t.id === state.termId);
  if (!term) return;
  const sel = $('#weekSelect');
  sel.innerHTML = Array.from({ length: term.weeks }, (_, i) => `<option value="${i + 1}">第 ${i + 1} 周</option>`).join('');
  sel.value = state.week;
}

function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function loadAll() {
  try {
    await loadTerms();
    if (!state.termId) { banner('尚未创建学期，请先在「学期设置」中新建学期。', false); return; }
    await loadWeekSelect();
    banner('');
    await Promise.all([loadBoard(), loadStats(), loadHolidays()]);
  } catch (e) {
    banner('加载失败：' + e.message + '　（若为 401，请点右上角「连接」填入 API Key）', true);
  }
}

async function loadBoard() {
  const r = await api(`/api/timetable?termId=${encodeURIComponent(state.termId)}&week=${state.week}`);
  state.data = r;
  if (r.week !== state.week) state.week = r.week;
  renderBoard();
  renderList();
}

async function loadStats() {
  const r = await api(`/api/stats?termId=${encodeURIComponent(state.termId)}`);
  state.stats = r.data;
  renderStats();
}

async function loadHolidays() {
  const r = await api(`/api/holidays?termId=${encodeURIComponent(state.termId)}`);
  state.holidays = r.items || [];
  renderHolidays();
}

/* ============================ 渲染 ============================ */

function renderStats() {
  const s = state.stats || {};
  const term = state.terms.find(t => t.id === state.termId) || {};
  const cells = [
    ['当前学期', term.name || '-'],
    ['周次', `第 ${state.week} / ${term.weeks || '-'} 周`],
    ['课程数', s.courseCount ?? 0],
    ['总课次', s.sessionCount ?? 0],
    ['总学分', s.creditSum ?? 0],
    ['放假天数', s.holidayCount ?? 0],
    ['调休天', s.makeupCount ?? 0],
  ];
  $('#stats').innerHTML = cells.map(([k, v]) =>
    `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
}

function renderBoard() {
  const d = state.data;
  if (!d) return;
  const today = todayStr();
  const dowNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  // 视图切换：窄屏默认「日程列表」，避免 7 列表格被压扁
  document.body.classList.toggle('view-agenda', state.view === 'agenda');
  $$('#viewSwitch .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  $('#weekRange').textContent = `第 ${d.week} / ${d.termWeeks} 周　${d.dates[1]} ~ ${d.dates[7]}`;

  $('#boardHead').innerHTML =
    '<div class="cell"></div>' +
    [1, 2, 3, 4, 5, 6, 7].map(i => {
      const date = d.dates[i] || '';
      return `<div class="cell ${date === today ? 'today' : ''}"><div class="dow">${dowNames[i]}</div><div class="date">${esc(date.slice(5))}</div></div>`;
    }).join('');

  $('#timeCol').innerHTML = d.periods.map(p =>
    `<div class="p" style="height:${ROW_H}px"><b>${p.index}</b><span>${esc(p.startTime)}</span><span>${esc(p.endTime)}</span></div>`).join('');

  const html = [1, 2, 3, 4, 5, 6, 7].map(i => {
    const items = (d.grid[i] || []).slice().sort((a, b) => a.startPeriod - b.startPeriod);
    const laid = layout(items);
    const blocks = laid.map(it => {
      const bg = it.color || '#4F7CF7';
      const style = `top:${(it.startPeriod - 1) * ROW_H + 3}px;height:${Math.max(34, (it.endPeriod - it.startPeriod + 1) * ROW_H - 6)}px;`
        + `left:calc(${(it._lane / it._lanes * 100).toFixed(3)}% + 2px);width:calc(${(100 / it._lanes).toFixed(3)}% - 4px);background:${bg}`;
      const sub = [it.location, it.teacher].filter(Boolean).join(' · ');
      return `<div class="block ${it.isMakeup ? 'mk' : ''}" style="${style}" data-id="${it.id}">
        <div class="t">${esc(it.name)}</div>
        ${sub ? `<div class="l">${esc(sub)}</div>` : ''}
        ${it.weeksText && it.weeksText.indexOf('全') < 0 && !it.weeksText.startsWith('1-' + (d.termWeeks) + '周') ? `<div class="l">${esc(it.weeksText)}</div>` : ''}
      </div>`;
    }).join('');
    const rows = d.periods.map(p => `<div class="p" style="height:${ROW_H}px" data-day="${i}" data-period="${p.index}"></div>`).join('');
    const isToday = (d.dates[i] || '') === today;
    return `<div class="day-col ${isToday ? 'today' : ''}" style="min-height:${d.periods.length * ROW_H}px">${rows}${blocks}</div>`;
  }).join('');

  $('#days').innerHTML = html;
  $$('.block', $('#days')).forEach(el => el.addEventListener('click', () => editCourse(el.dataset.id)));
  $$('.day-col .p', $('#days')).forEach(el => el.addEventListener('click', () => {
    openCourseModal(null, Number(el.dataset.day), Number(el.dataset.period));
  }));

  renderAgenda();
}

/** 手机友好的纵向日程列表：按天分组，无需横向滚动 */
function renderAgenda() {
  const d = state.data;
  if (!d) return;
  const today = todayStr();
  const dowNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  $('#agenda').innerHTML = [1, 2, 3, 4, 5, 6, 7].map(i => {
    const date = d.dates[i] || '';
    const items = (d.grid[i] || []).slice().sort((a, b) => a.startPeriod - b.startPeriod);
    const isToday = date === today;
    const hol = (d.holidays || []).find(h => h.date === date);

    const body = items.length
      ? items.map(c => `
        <div class="ag-item" style="border-left-color:${esc(c.color || '#4F7CF7')}" data-id="${esc(c.id)}">
          <div class="ag-time">${esc(c.startTime)}<span>${esc(c.endTime)}</span></div>
          <div class="ag-main">
            <div class="ag-title">${esc(c.name)}${c.isMakeup ? '<span class="ag-mk">调休</span>' : ''}</div>
            <div class="ag-sub">${[
              c.location, c.teacher,
              (c.endPeriod && c.endPeriod !== c.startPeriod ? `第${c.startPeriod}-${c.endPeriod}节` : `第${c.startPeriod}节`),
              c.weeksText,
            ].filter(Boolean).map(esc).join(' · ')}</div>
          </div>
        </div>`).join('')
      : `<div class="ag-empty">${hol ? (hol.type === 'makeup' ? '调休日（本周无对应课程）' : '放假') : '无课'}</div>`;

    return `<div class="ag-day ${isToday ? 'today' : ''}">
      <div class="ag-head">
        <span class="ag-dow">${dowNames[i]}<em>${esc(date.slice(5))}</em>${isToday ? '<span class="ag-today">今天</span>' : ''}</span>
        ${hol ? `<span class="ag-flag ${hol.type}">${hol.type === 'makeup' ? '调休 · 按' + dowNames[hol.targetDayOfWeek] + '课表' : '放假'}</span>` : ''}
        <button class="ag-add" data-day="${i}" title="在这一天添加课程">＋</button>
      </div>
      ${body}
    </div>`;
  }).join('');

  $$('#agenda .ag-item').forEach(el => { el.onclick = () => editCourse(el.dataset.id); });
  $$('#agenda .ag-add').forEach(el => { el.onclick = () => openCourseModal(null, Number(el.dataset.day), 1); });
}

/** 简易泳道分配：同一天内冲突的课程横向分列 */
function layout(items) {
  const lanes = [];
  const out = items.map(it => {
    const start = it.startPeriod;
    const end = it.endPeriod || it.startPeriod;
    let lane = lanes.findIndex(e => e < start);
    if (lane < 0) { lane = lanes.length; lanes.push(end); } else lanes[lane] = end;
    return { ...it, _lane: lane, startPeriod: start, endPeriod: end };
  });
  // 计算每个条目所在重叠分组的列数
  out.forEach(a => {
    let max = a._lane;
    out.forEach(b => {
      if (b === a) return;
      if (a.startPeriod <= b.endPeriod && b.startPeriod <= a.endPeriod) max = Math.max(max, b._lane);
    });
    a._lanes = max + 1;
  });
  return out;
}

function renderList() {
  const items = state.terms.find(t => t.id === state.termId) ? [] : [];
  api(`/api/courses?termId=${encodeURIComponent(state.termId)}`).then(r => {
    const list = r.items || [];
    $('#listCount').textContent = `共 ${list.length} 条`;
    const dowNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    $('#courseTable tbody').innerHTML = list.map(c => `<tr>
      <td><span class="swatch" style="background:${esc(c.color || '#4F7CF7')}"></span>${esc(c.name)}<span class="m-sub">${[c.teacher, c.location].filter(Boolean).map(esc).join(' · ')}</span></td>
      <td>${esc(c.teacher || '-')}</td>
      <td>${esc(c.location || '-')}</td>
      <td>${dowNames[c.dayOfWeek]}</td>
      <td>${c.startPeriod}${c.endPeriod && c.endPeriod !== c.startPeriod ? '-' + c.endPeriod : ''} 节</td>
      <td><span class="tag">${esc(weeksTextOf(c))}</span></td>
      <td>${esc(c.className || '-')}</td>
      <td>
        <button class="rowbtn" data-edit="${c.id}">编辑</button>
        <button class="rowbtn del" data-del="${c.id}">删除</button>
      </td></tr>`).join('');
    $$('[data-edit]', $('#courseTable')).forEach(b => b.onclick = () => editCourse(b.dataset.edit));
    $$('[data-del]', $('#courseTable')).forEach(b => b.onclick = async () => {
      if (!confirm('确认删除该课程？')) return;
      try { await api('/api/courses/' + b.dataset.del, { method: 'DELETE' }); toast('已删除'); await loadAll(); }
      catch (e) { toast(e.message, true); }
    });
  }).catch(() => {});
}

function weeksTextOf(c) {
  const w = c.weeks || { mode: 'all' };
  const total = (state.terms.find(t => t.id === state.termId) || {}).weeks || 20;
  switch (w.mode) {
    case 'all': return `1-${total}周`;
    case 'list': {
      // 压缩为区间：1,2,3,5,7,8 -> 1-3周,5周,7-8周
      const a = [...new Set(w.list || [])].sort((x, y) => x - y);
      const out = []; let s = a[0], p = a[0];
      for (let i = 1; i <= a.length; i++) {
        if (a[i] === p + 1) { p = a[i]; continue; }
        out.push(s === p ? `${s}周` : `${s}-${p}周`);
        s = p = a[i];
      }
      return out.join(',');
    }
    case 'odd': return w.start === w.end ? `${w.start}周(单)` : `${w.start}-${w.end}周(单)`;
    case 'even': return w.start === w.end ? `${w.start}周(双)` : `${w.start}-${w.end}周(双)`;
    case 'range': return w.start === w.end ? `${w.start}周` : `${w.start}-${w.end}周`;
    default: return '-';
  }
}

function renderHolidays() {
  const dowNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  $('#holidayTable tbody').innerHTML = state.holidays.map(h => `<tr>
    <td>${esc(h.date)}</td>
    <td>${h.type === 'holiday' ? '<span class="tag">放假</span>' : '<span class="tag">调休</span>'}</td>
    <td>${h.targetDayOfWeek ? dowNames[h.targetDayOfWeek] : '-'}</td>
    <td>${esc(h.name || '-')}</td>
    <td><button class="rowbtn del" data-hdel="${h.id}">删除</button></td></tr>`).join('') ||
    '<tr><td colspan="5" class="muted">暂无记录</td></tr>';
  $$('[data-hdel]').forEach(b => b.onclick = async () => {
    try { await api('/api/holidays/' + b.dataset.hdel, { method: 'DELETE' }); await loadHolidays(); await loadBoard(); await loadStats(); toast('已删除'); }
    catch (e) { toast(e.message, true); }
  });
}

/* ============================ 课程编辑 ============================ */

function weeksPayload() {
  const mode = $('#f_weeksMode').value;
  if (mode === 'all') return { mode: 'all' };
  if (mode === 'list') {
    const raw = $('#f_weeksList').value.trim();
    return { mode: 'list', list: raw ? raw : [1] };
  }
  const s = Number($('#f_weeksStart').value) || 1;
  const e = Number($('#f_weeksEnd').value) || 16;
  return { mode, start: Math.min(s, e), end: Math.max(s, e) };
}

function openCourseModal(course, day, period) {
  const isNew = !course;
  $('#courseModalTitle').textContent = isNew ? '新增课程' : '编辑课程';
  $('#f_id').value = course ? course.id : '';
  $('#f_name').value = course ? course.name : '';
  $('#f_teacher').value = course ? course.teacher : '';
  $('#f_location').value = course ? course.location : '';
  $('#f_className').value = course ? course.className : '';
  $('#f_dayOfWeek').value = course ? course.dayOfWeek : (day || 1);
  $('#f_startPeriod').value = course ? course.startPeriod : (period || 1);
  $('#f_endPeriod').value = course ? (course.endPeriod || course.startPeriod) : (period || 1);
  $('#f_startTime').value = course ? (course.startTime || '') : '';
  $('#f_endTime').value = course ? (course.endTime || '') : '';
  $('#f_credit').value = course && course.credit != null ? course.credit : '';
  $('#f_note').value = course ? (course.note || '') : '';
  $('#f_color').value = course && course.color ? course.color : PALETTE[Math.floor(Math.random() * PALETTE.length)];

  const w = (course && course.weeks) || { mode: 'all' };
  $('#f_weeksMode').value = w.mode || 'all';
  const total = (state.terms.find(t => t.id === state.termId) || {}).weeks || 20;
  $('#f_weeksStart').value = w.start || 1;
  $('#f_weeksEnd').value = w.end || total;
  $('#f_weeksList').value = (w.list || []).join(',');
  syncWeeksUI();
  $('#btnDeleteCourse').hidden = isNew;
  openModal('#modalCourse');
}

function syncWeeksUI() {
  const m = $('#f_weeksMode').value;
  $('#weeksRangeRow').className = (m === 'all') ? 'row3 hidden' : 'row3';
  $('#weeksListRow').className = (m === 'list') ? '' : 'hidden';
}

async function editCourse(id) {
  try {
    const r = await api('/api/courses/' + id);
    openCourseModal(r.item);
  } catch (e) { toast(e.message, true); }
}

async function saveCourse() {
  const payload = {
    termId: state.termId,
    name: $('#f_name').value.trim(),
    teacher: $('#f_teacher').value.trim(),
    location: $('#f_location').value.trim(),
    className: $('#f_className').value.trim(),
    dayOfWeek: Number($('#f_dayOfWeek').value),
    startPeriod: Number($('#f_startPeriod').value),
    endPeriod: Number($('#f_endPeriod').value) || Number($('#f_startPeriod').value),
    weeks: weeksPayload(),
    credit: $('#f_credit').value === '' ? null : Number($('#f_credit').value),
    note: $('#f_note').value.trim(),
    color: $('#f_color').value,
  };
  const st = $('#f_startTime').value.trim(); if (st) payload.startTime = st;
  const et = $('#f_endTime').value.trim(); if (et) payload.endTime = et;

  const id = $('#f_id').value;
  try {
    if (id) await api('/api/courses/' + id, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/courses', { method: 'POST', body: JSON.stringify(payload) });
    closeModals(); toast(id ? '已保存' : '已新增');
    await loadAll();
  } catch (e) {
    toast(e.payload && e.payload.errors ? e.payload.errors.join('；') : e.message, true);
  }
}

/* ============================ 学期设置 ============================ */

function openTermModal() {
  const term = state.terms.find(t => t.id === state.termId);
  if (!term) { openModal('#modalTerm'); $('#t_name').value = ''; return; }
  api('/api/terms/' + term.id).then(r => {
    const t = r.item;
    $('#t_name').value = t.name;
    $('#t_startDate').value = t.startDate;
    $('#t_weeks').value = t.weeks;
    $('#periodRows').innerHTML = t.periods.map((p, i) => periodRow(p, i)).join('');
    bindPeriodRows();
    openModal('#modalTerm');
  }).catch(e => toast(e.message, true));
}

function periodRow(p, i) {
  return `<div class="period-row" data-i="${i}">
    <input type="number" value="${p.index}" data-k="index" min="1" title="节次序号">
    <input value="${esc(p.name)}" data-k="name" placeholder="节次名">
    <input value="${esc(p.startTime)}" data-k="startTime" placeholder="08:00">
    <input value="${esc(p.endTime)}" data-k="endTime" placeholder="08:45">
    <button class="btn icon" data-rm="1">×</button>
  </div>`;
}

function bindPeriodRows() {
  $$('#periodRows [data-rm]').forEach(b => b.onclick = () => { b.closest('.period-row').remove(); });
}

function collectPeriods() {
  return $$('#periodRows .period-row').map((row, i) => ({
    index: Number($('[data-k=index]', row).value) || i + 1,
    name: $('[data-k=name]', row).value.trim(),
    startTime: $('[data-k=startTime]', row).value.trim(),
    endTime: $('[data-k=endTime]', row).value.trim(),
  }));
}

async function saveTerm() {
  const payload = {
    name: $('#t_name').value.trim(),
    startDate: $('#t_startDate').value,
    weeks: Number($('#t_weeks').value),
    periods: collectPeriods(),
  };
  try {
    if (state.termId) {
      const r = await api('/api/terms/' + state.termId, { method: 'PUT', body: JSON.stringify(payload) });
      toast('学期已保存');
    } else {
      await api('/api/terms', { method: 'POST', body: JSON.stringify(payload) });
      toast('学期已创建');
    }
    closeModals();
    await loadAll();
  } catch (e) {
    toast(e.payload && e.payload.errors ? e.payload.errors.join('；') : e.message, true);
  }
}

/* ============================ 导出 ============================ */

async function doExport(fmt) {
  const q = new URLSearchParams({
    format: fmt, termId: state.termId,
    mode: $('#f_expMode').value,
    tz: $('#f_expTz').value,
    remind: $('#f_expRemind').value,
  });
  try {
    const res = await fetch('/api/export?' + q.toString(), { headers: { 'X-API-Key': state.key } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ext = { json: 'json', csv: 'csv', 'csv-grid': 'csv', xlsx: 'xlsx', ics: 'ics' }[fmt];
    const term = (state.terms.find(t => t.id === state.termId) || {}).name || '课表';
    const buf = await res.arrayBuffer();
    downloadBlob(buf, `${term.replace(/[\\/:*?"<>|]/g, '_')}.${ext}`, res.headers.get('content-type') || 'application/octet-stream');
    toast('已下载 ' + ext.toUpperCase());
  } catch (e) { toast('导出失败：' + e.message, true); }
}

/* ============================ 导入 ============================ */

async function doImport() {
  const tab = $('.tab.active').dataset.imp;
  const body = {
    termId: $('#f_importTerm').value || null,
    format: $('#f_importFormat').value,
    mode: $('#f_importMode').value,
  };
  if (tab === 'url') {
    body.url = $('#f_importUrl').value.trim();
    if (!body.url) return toast('请填写远程地址', true);
  } else if (tab === 'json') {
    const text = $('#f_importJson').value.trim();
    if (!text) return toast('请填写 JSON 内容', true);
    try { body.data = JSON.parse(text); } catch (e) { return toast('JSON 解析失败：' + e.message, true); }
  } else {
    const text = $('#f_importText').value;
    if (!text.trim()) return toast('请上传文件或粘贴内容', true);
    body.data = text;
  }
  const box = $('#importResult');
  box.classList.remove('hidden');
  box.textContent = '导入中…';
  try {
    const r = await api('/api/import', { method: 'POST', body: JSON.stringify(body) });
    box.textContent = JSON.stringify(r, null, 2);
    toast(`导入完成：新增 ${r.created}，更新 ${r.updated}，跳过 ${r.skipped}`);
    await loadAll();
  } catch (e) {
    box.textContent = '导入失败：\n' + e.message + '\n\n' + JSON.stringify(e.payload || {}, null, 2);
    toast('导入失败：' + e.message, true);
  }
}

/* ============================ 订阅 ============================ */

async function openSubscribe() {
  try {
    const r = await api(`/api/subscription?termId=${encodeURIComponent(state.termId)}`);
    $('#subUrl').value = r.urls.subscribe;
    updateSubFull();
    openModal('#modalSubscribe');
  } catch (e) { toast(e.message, true); }
}

function updateSubFull() {
  const base = $('#subUrl').value;
  $('#subUrlFull').value = `${base}?mode=${$('#subMode').value}&remind=${$('#subRemind').value}`;
}

async function downloadIcs() {
  const url = $('#subUrlFull').value;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const term = (state.terms.find(t => t.id === state.termId) || {}).name || '课表';
    downloadBlob(await res.arrayBuffer(), `${term}.ics`, 'text/calendar');
    toast('已下载 ICS 文件');
  } catch (e) { toast(e.message, true); }
}

/* ============================ 事件绑定 ============================ */

$('#btnConn').onclick = () => { $('#apiKeyInput').value = state.key; openModal('#modalConn'); };
$('#btnSaveKey').onclick = async () => {
  state.key = $('#apiKeyInput').value.trim();
  localStorage.setItem(KEY_STORAGE, state.key);
  closeModals();
  await loadAll();
  toast('已保存');
};

$('#termSelect').onchange = () => { state.termId = $('#termSelect').value; state.week = 1; loadAll(); };
$('#weekSelect').onchange = () => { state.week = Number($('#weekSelect').value); loadBoard(); };
$('#prevWeek').onclick = () => setWeek(state.week - 1);
$('#nextWeek').onclick = () => setWeek(state.week + 1);
$('#thisWeek').onclick = async () => {
  const term = state.terms.find(t => t.id === state.termId);
  const start = new Date(term.startDate + 'T00:00:00');
  const now = new Date();
  const diff = Math.floor((now - start) / 86400000);
  setWeek(Math.min(term.weeks, Math.max(1, Math.floor(diff / 7) + 1)));
};
function setWeek(w) {
  const term = state.terms.find(t => t.id === state.termId);
  if (!term) return;
  state.week = Math.min(term.weeks, Math.max(1, w));
  $('#weekSelect').value = state.week;
  loadBoard();
}

$$('#viewSwitch .seg-btn').forEach(b => b.onclick = () => {
  state.view = b.dataset.view;
  renderBoard();
});

$('#btnAddCourse').onclick = () => openCourseModal(null, 1, 1);
$('#btnImport').onclick = () => openModal('#modalImport');
$('#btnExport').onclick = () => openModal('#modalExport');
$('#btnTermSettings').onclick = openTermModal;
$('#btnHoliday').onclick = () => openModal('#modalHoliday');
$('#btnSubscribe').onclick = openSubscribe;
$('#btnSaveCourse').onclick = saveCourse;
$('#btnDoImport').onclick = doImport;
$('#f_weeksMode').onchange = syncWeeksUI;
$('#btnSaveTerm').onclick = saveTerm;
$('#btnAddPeriod').onclick = () => {
  const rows = $$('#periodRows .period-row').length;
  $('#periodRows').insertAdjacentHTML('beforeend', periodRow({ index: rows + 1, name: '', startTime: '', endTime: '' }, rows));
  bindPeriodRows();
};
$('#btnDownloadIcs').onclick = downloadIcs;
$('#subMode').onchange = updateSubFull;
$('#subRemind').oninput = updateSubFull;
$('#btnCopySub').onclick = () => copy('#subUrl');
$('#btnCopySubFull').onclick = () => copy('#subUrlFull');
function copy(sel) {
  const el = $(sel);
  el.select();
  navigator.clipboard?.writeText(el.value).then(() => toast('已复制到剪贴板')).catch(() => toast('复制失败，请手动选择'));
}
$('#btnRotateToken').onclick = async () => {
  if (!confirm('重置后旧地址立即失效，需重新在手机上添加订阅。继续？')) return;
  try {
    const r = await api(`/api/terms/${state.termId}/token`, { method: 'POST' });
    $('#subUrl').value = r.subscribeUrl; updateSubFull(); toast('令牌已重置');
  } catch (e) { toast(e.message, true); }
};
$('#btnDeleteTerm').onclick = async () => {
  if (!confirm('删除学期将同时删除其下全部课程与节假日，确认删除？')) return;
  try {
    await api('/api/terms/' + state.termId, { method: 'DELETE' });
    state.termId = null; closeModals(); await loadAll(); toast('已删除');
  } catch (e) { toast(e.message, true); }
};
$('#btnAddTerm').onclick = () => {
  state.termId = null;
  $('#t_name').value = '';
  const d = new Date();
  const dow = d.getDay() === 0 ? 6 : d.getDay() - 1;
  const monday = new Date(d.getTime() - dow * 86400000);
  $('#t_startDate').value = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  $('#t_weeks').value = 20;
  $('#periodRows').innerHTML = [
    [1, '08:00', '08:45'], [2, '08:55', '09:40'], [3, '10:00', '10:45'], [4, '10:55', '11:40'],
    [5, '14:00', '14:45'], [6, '14:55', '15:40'], [7, '16:00', '16:45'], [8, '16:55', '17:40'],
    [9, '19:00', '19:45'], [10, '19:55', '20:40'],
  ].map(([i, s, e]) => periodRow({ index: i, name: `第${i}节`, startTime: s, endTime: e }, i - 1)).join('');
  bindPeriodRows();
  toast('填写后点击「保存」即创建新学期');
};

$$('.xcard').forEach(b => b.onclick = () => doExport(b.dataset.export));
$$('.tab').forEach(t => t.onclick = () => {
  $$('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  ['file', 'url', 'json'].forEach(k => $('#imp-' + k).classList.toggle('hidden', k !== t.dataset.imp));
});

$('#uploader').onclick = () => $('#f_file').click();
$('#f_file').onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const fr = new FileReader();
  fr.onload = () => { $('#f_importText').value = fr.result; toast(`已读取 ${f.name}`); };
  fr.readAsText(f, 'UTF-8');
};
$('#btnTemplate').onclick = async () => {
  for (const fmt of ['csv', 'xlsx']) {
    try {
      const res = await fetch(`/api/export/template?format=${fmt}`, { headers: { 'X-API-Key': state.key } });
      if (!res.ok) continue;
      downloadBlob(await res.arrayBuffer(), `课表导入模板.${fmt}`, res.headers.get('content-type'));
    } catch (e) { /* 忽略 */ }
  }
  toast('模板已下载');
};

$('#h_type').onchange = () => $('#h_targetRow').classList.toggle('hidden', $('#h_type').value !== 'makeup');
$('#btnAddHoliday').onclick = async () => {
  const payload = {
    termId: state.termId,
    date: $('#h_date').value,
    type: $('#h_type').value,
    name: $('#h_name').value.trim(),
  };
  if (payload.type === 'makeup') payload.targetDayOfWeek = Number($('#h_targetDayOfWeek').value);
  try {
    await api('/api/holidays', { method: 'POST', body: JSON.stringify(payload) });
    $('#h_name').value = '';
    await loadHolidays(); await loadBoard(); await loadStats();
    toast('已添加');
  } catch (e) { toast(e.payload && e.payload.errors ? e.payload.errors.join('；') : e.message, true); }
};
$('#btnDeleteCourse').onclick = async () => {
  if (!confirm('确认删除该课程？')) return;
  try { await api('/api/courses/' + $('#f_id').value, { method: 'DELETE' }); closeModals(); await loadAll(); toast('已删除'); }
  catch (e) { toast(e.message, true); }
};

/* ============================ 启动 ============================ */

(async function boot() {
  const hashKey = new URLSearchParams(location.hash.slice(1)).get('key');
  state.key = hashKey || localStorage.getItem(KEY_STORAGE) || '';
  if (hashKey) localStorage.setItem(KEY_STORAGE, hashKey);
  if (!state.key) {
    openModal('#modalConn');
    banner('尚未配置 API Key。服务启动时控制台会打印，也可在 data/config.json 中查看。', false);
    return;
  }
  await loadAll();
})();
