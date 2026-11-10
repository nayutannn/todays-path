import * as U from './util.js';
import * as S from './store.js';
import * as Sync from './sync.js';
import * as Push from './push.js';
import './claude.js';
import * as Backup from './backup.js';
import { holidayName } from './holidays.js';

const { state } = S;
const { esc, ymd, hm, parse, addDays, startOfDay } = U;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const PRIORITY = ['なし', '低', '中', '高'];
const LEADS = [[0, 'なし'], [3, '3日前から'], [7, '1週間前から'], [14, '2週間前から'], [30, '1か月前から']];
// 数値は「何分前」、'd0@12:00' は当日 12 時（S.reminderAt を参照）
const REM_PRESETS = [[0, 'ちょうど'], [5, '5分前'], [10, '10分前'], [15, '15分前'], [30, '30分前'], [45, '45分前'], [60, '1時間前'],
  [90, '1時間30分前'], [120, '2時間前'], [180, '3時間前'], [360, '6時間前'], [720, '12時間前'],
  ['d0@07:00', '当日 7時'], ['d0@09:00', '当日 9時'], ['d0@12:00', '当日 12時'], ['d0@16:00', '当日 16時'], ['d0@20:00', '当日 20時'],
  ['d-1@12:00', '前日 12時'], ['d-1@20:00', '前日 20時'], ['d-1@22:00', '前日 22時'],
  [1440, '1日前'], [2880, '2日前'], [4320, '3日前'], [10080, '1週間前']];

let view = 'path';
let pathTarget = null;      // null = 今日（0時で切り替わる）
function readHash() {
  const h = location.hash.slice(1) || 'path';
  if (h === 'path-tomorrow') { pathTarget = addDays(startOfDay(new Date()), 1); view = 'path'; history.replaceState(null, '', '#path'); }
  else view = h;
}
readHash();
let todoTab = 'all';
let showDone = false;
let cal = null;             // { first: 週の先頭日, weeks: 週数 }
let calQuery = '';

/* ================= 共通UI ================= */
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

function modal(html) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog">${html}</div>`;
  document.body.append(back);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  // Esc は一番上の画面だけ閉じる（予定の編集の上に色選びを開いているときなど）
  const onKey = e => { if (e.key === 'Escape' && back === [...document.querySelectorAll('.modal-back')].pop()) close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', e => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  return { el: back.firstElementChild, close };
}

function choose(message, choices) {
  return new Promise(resolve => {
    const m = modal(`<p class="msg">${message}</p><div class="actions col">${choices.map(([v, l, cls]) =>
      `<button type="button" class="${cls || ''}" data-v="${v}">${l}</button>`).join('')}<button type="button" data-v="">キャンセル</button></div>`);
    m.el.addEventListener('click', e => {
      const b = e.target.closest('[data-v]');
      if (b) { m.close(); resolve(b.dataset.v); }
    });
  });
}

// 予定の色（タグで決まる）を CSS 変数 --c として渡す
// 予定の色の CSS 変数。タグが複数なら色を均等に分ける（左から、タグの一覧の上にあるタグの色）
//   --c: 最初の色 / --cg: 横に並べた色 / --cgt: その淡い色 / --cv: 縦に並べた色（細い線用）
function colorVars(ev) {
  const cs = S.eventColors(ev), n = cs.length;
  const grad = (dir, f) => `linear-gradient(${dir}, ${cs.map((c, i) => `${f(c)} ${(i * 100 / n).toFixed(2)}% ${((i + 1) * 100 / n).toFixed(2)}%`).join(', ')})`;
  const tint = c => `color-mix(in srgb, ${c} 15%, var(--surface))`;
  return `--c:${cs[0]};--cg:${grad('90deg', c => c)};--cgt:${grad('90deg', tint)};--cv:${grad('180deg', c => c)}`;
}
const cs = ev => `style="${colorVars(ev)}"`;
const tagChip = (name, on) => `<button type="button" class="tchip ${on ? 'on' : ''}" data-tag="${esc(name)}" style="--c:${S.tagColor(name) || S.DEFAULT_COLOR}">${esc(name)}</button>`;

const timeSelect = (name, value) => `<select name="${name}">${U.TIMES.map(t =>
  `<option ${t === value ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
const options = (pairs, value) => pairs.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${l}</option>`).join('');
const repeatFields = rep => `
  <div class="row">
    <label>繰り返し</label>
    <span class="inline">
      <input type="number" name="interval" min="1" value="${rep?.interval || 1}" class="num">
      <select name="freq">${options(Object.entries(S.FREQ_LABEL), rep?.freq || 'none')}</select>
      <span class="hint">ごと</span>
    </span>
  </div>`;

const remRow = m => `<div class="rem"><select>${options(REM_PRESETS, m)}</select><button type="button" class="icon" data-rem-del>×</button></div>`;
const remEditor = list => `<div class="rems">${(list || []).map(remRow).join('')}</div><button type="button" class="link" data-rem-add>＋ 通知を追加</button>`;
function bindRem(root) {
  root.addEventListener('click', e => {
    if (e.target.closest('[data-rem-add]')) $('.rems', root).insertAdjacentHTML('beforeend', remRow(10));
    if (e.target.closest('[data-rem-del]')) e.target.closest('.rem').remove();
  });
}
const remVal = v => /^-?\d+$/.test(v) ? Number(v) : v;
const readRem = root => [...new Set($$('.rems select', root).map(s => remVal(s.value)))]
  .sort((a, b) => (typeof a === 'string') - (typeof b === 'string') || (typeof a === 'number' ? a - b : a.localeCompare(b)));

/* ================= 予定フォーム ================= */
/* ---------- 情報元（Claude が追加・提案した項目の出どころ） ---------- */
const srcName = s => s === 'claude' ? 'Claude（チャットで依頼）' : s;
// 一覧用の短い表示
function srcLine(x) {
  if (!x.source || x.source === 'manual') return '';
  return `<div class="src">情報元: ${esc(srcName(x.source))}${x.sourceNote ? `<br><small>${esc(x.sourceNote)}</small>` : ''}</div>`;
}
// 編集画面用（変更を承認した項目は、その変更の情報元も出す）
function srcHtml(x) {
  if (!x) return '';
  const parts = [];
  if (x.source && x.source !== 'manual') parts.push(`<b>Claude が追加</b>　${esc(srcName(x.source))}${x.sourceNote ? `<br><small>${esc(x.sourceNote)}</small>` : ''}`);
  if (x.changeSource) parts.push(`<b>Claude の提案で変更</b>　${esc(srcName(x.changeSource))}${x.changeNote ? `<br><small>${esc(x.changeNote)}</small>` : ''}`);
  return parts.length ? `<div class="srcbox">${parts.join('<hr>')}</div>` : '';
}

function openEventForm(ev, { date, occDate } = {}) {
  const isNew = !ev;
  if (!ev) {
    const now = new Date();
    const st = date ? new Date(...date.split('-').map((x, i) => i === 1 ? x - 1 : +x), Math.min(now.getHours() + 1, 23))
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.min(now.getHours() + 1, 23));
    ev = { title: '', allDay: false, start: U.toLocal(st), end: U.toLocal(U.addMinutes(st, 60)), tags: [],
      repeat: { freq: 'none', interval: 1, until: '' }, reminders: [10], location: '', memo: '' };
  }
  const [sd, st = '09:00'] = ev.start.split('T');
  const [ed, et = '10:00'] = (ev.end || ev.start).split('T');
  const work = S.isWork(ev);
  const m = modal(`
    <form class="form">
      <div class="mhead"><h2>${isNew ? '予定を追加' : '予定を編集'}</h2><button type="button" class="icon" data-close>×</button></div>
      ${srcHtml(ev)}
      <input name="title" class="title-in" placeholder="タイトル" value="${esc(ev.title)}" required autocomplete="off">
      <label class="check"><input type="checkbox" name="allDay" ${ev.allDay ? 'checked' : ''}> 終日</label>
      <div class="row"><label>開始</label><span class="inline"><input type="date" name="sd" value="${sd}" required><span class="tm">${timeSelect('st', st)}</span></span></div>
      <div class="row"><label>終了</label><span class="inline"><input type="date" name="ed" value="${ed}" required><span class="tm">${timeSelect('et', et)}</span></span></div>
      ${repeatFields(ev.repeat)}
      <div class="row rep-until"><label>繰り返し終了</label><input type="date" name="until" value="${ev.repeat?.until || ''}"></div>
      <div class="row"><label>場所</label><input name="location" value="${esc(ev.location)}" autocomplete="off"></div>
      <div class="row top"><label>タグ<br><small>色はタグで決まります</small></label>
        <div class="tagpick">${[...S.tagList().map(t => t.name), ...S.unregisteredTags(), ...(ev.tags || [])].filter((v, i, a) => v && a.indexOf(v) === i)
          .map(t => tagChip(t, (ev.tags || []).includes(t))).join('')}
          <input class="newtag" placeholder="＋ 新しいタグ" autocomplete="off" enterkeyhint="done"></div></div>
      <input type="hidden" name="tags" value="${esc((ev.tags || []).join(','))}">
      <div class="work ${work ? '' : 'hidden'}">
        <div class="row"><label>時給</label><span class="inline"><input type="number" name="wage" min="0" step="10" value="${ev.wage ?? state.settings.defaultWage}" class="num w">円</span></div>
        <div class="row"><label>休憩</label><span class="inline"><input type="number" name="breakMin" min="0" step="5" value="${ev.breakMin ?? 0}" class="num">分</span></div>
      </div>
      <div class="row top"><label>通知</label><div>${remEditor(ev.reminders)}</div></div>
      <textarea name="memo" placeholder="メモ" rows="3">${esc(ev.memo)}</textarea>
      <div class="actions">
        ${isNew ? '' : '<button type="button" class="danger" data-del>削除</button><button type="button" data-mk-todo>todoを作成</button>'}
        <span class="sp"></span><button class="primary">保存</button>
      </div>
    </form>`);
  const f = $('form', m.el);
  bindRem(f);
  const sync = () => {
    f.classList.toggle('allday', f.allDay.checked);
    $('.rep-until', f).classList.toggle('hidden', f.freq.value === 'none');
    $('.work', f).classList.toggle('hidden', !readTags().includes(state.settings.workTag));
  };
  const readTags = () => f.tags.value.split(',').filter(Boolean);
  f.addEventListener('input', sync);
  f.sd.addEventListener('change', () => { if (f.ed.value < f.sd.value) f.ed.value = f.sd.value; });
  f.st.addEventListener('change', () => {
    if (f.sd.value === f.ed.value && f.et.value <= f.st.value) f.et.value = U.TIMES[Math.min(287, U.TIMES.indexOf(f.st.value) + 12)];
  });
  const pick = $('.tagpick', f);
  pick.addEventListener('click', e => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    const t = b.dataset.tag, cur = readTags();
    f.tags.value = (cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t]).join(',');
    b.classList.toggle('on', !cur.includes(t));
    sync();
  });
  // 新しいタグ: 入力して Enter（または欄から離れる）で、選んだ状態のタグとして足す
  const nt = $('.newtag', pick);
  const newColors = {};      // この画面で作った新しいタグの色（保存するときに登録する）
  const addNew = async () => {
    const name = nt.value.replace(/,/g, '').trim();
    nt.value = '';
    if (!name) return;
    if (!readTags().includes(name)) f.tags.value = [...readTags(), name].join(',');
    const old = $$('[data-tag]', pick).find(b => b.dataset.tag === name);
    if (old) { old.classList.add('on'); sync(); return; }
    nt.insertAdjacentHTML('beforebegin', tagChip(name, true));
    sync();
    if (S.tagColor(name)) return;
    const c = await chooseColor(name, nextColor());      // 新しいタグはその場で色を選ぶ
    newColors[name] = c || nextColor();
    $$('[data-tag]', pick).find(b => b.dataset.tag === name)?.style.setProperty('--c', newColors[name]);
  };
  nt.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addNew(); } });
  nt.addEventListener('change', addNew);
  sync();
  if (isNew) setTimeout(() => f.elements.title.focus(), 50);

  f.addEventListener('submit', async e => {
    e.preventDefault();
    const allDay = f.allDay.checked;
    const draft = {
      ...ev, title: f.elements.title.value.trim(), allDay,
      start: allDay ? f.sd.value : `${f.sd.value}T${f.st.value}`,
      end: allDay ? f.ed.value : `${f.ed.value}T${f.et.value}`,
      location: f.location.value.trim(), memo: f.memo.value,
      tags: readTags(),
      repeat: { freq: f.freq.value, interval: Math.max(1, +f.interval.value || 1), until: f.freq.value === 'none' ? '' : f.until.value },
      reminders: readRem(f),
    };
    if (S.isWork(draft)) { draft.wage = +f.wage.value || 0; draft.breakMin = +f.breakMin.value || 0; }
    if (parse(draft.end) < parse(draft.start)) return toast('終了が開始より前になっています');
    const hits = S.findConflicts(draft, ev.id);
    if (hits.length) {
      const list = hits.slice(0, 5).map(o => `・${U.fmtDate(o.start)} ${hm(o.start)}–${hm(o.end)} ${esc(o.ev.title)}`).join('<br>');
      const ok = await choose(`<b>⚠ ダブルブッキング</b><br>次の予定と時間が重なっています。<br>${list}`, [['save', 'それでも保存', 'primary']]);
      if (!ok) return;
    }
    delete draft.color;      // 色はタグで決まる（以前の色の指定は使わない）
    S.registerTags(draft.tags, newColors);
    S.upsertEvent(draft);
    m.close();
    toast('予定を保存しました');
  });
  $('[data-del]', f)?.addEventListener('click', async () => {
    const rep = ev.repeat?.freq && ev.repeat.freq !== 'none';
    const day = occDate || ev.start.slice(0, 10);
    const v = rep
      ? await choose(`この繰り返し予定（${U.fmtDate(parse(day))}の回）を削除します`, [['one', 'この日の予定のみ', 'danger'], ['after', 'この日以降すべて', 'danger'], ['all', 'すべての繰り返し', 'danger']])
      : await choose(`「${esc(ev.title)}」を削除しますか？`, [['all', '削除', 'danger']]);
    if (!v) return;
    if (v === 'after') S.deleteEventFrom(ev.id, day);
    else S.deleteEvent(ev.id, v === 'one' ? day : null);
    m.close();
  });
  $('[data-mk-todo]', f)?.addEventListener('click', () => {
    m.close();
    openTodoForm(null, { title: `${ev.title}の準備`, doDate: (occDate || ev.start.slice(0, 10)), context: ev.location || ev.title });
  });
}

/* ================= todoフォーム ================= */
function openTodoForm(t, preset = {}) {
  const isNew = !t;
  t ||= { title: '', tabId: todoTab !== 'all' ? todoTab : state.tabs[0].id, due: '', doDate: '', priority: 0,
    repeat: { freq: 'none', interval: 1 }, longLead: 0, context: '', memo: '', reminders: [], ...preset };
  const [dd, dt = '23:55'] = (t.due || '').split('T');
  const m = modal(`
    <form class="form">
      <div class="mhead"><h2>${isNew ? 'todoを追加' : 'todoを編集'}</h2><button type="button" class="icon" data-close>×</button></div>
      ${srcHtml(t)}
      <input name="title" class="title-in" placeholder="やること" value="${esc(t.title)}" required autocomplete="off">
      <div class="row"><label>リスト</label><select name="tabId">${options(state.tabs.map(x => [x.id, esc(x.name)]), t.tabId)}</select></div>
      <div class="row"><label>優先度</label><div class="seg prio">${PRIORITY.map((p, i) =>
        `<label><input type="radio" name="priority" value="${i}" ${+t.priority === i ? 'checked' : ''}><span class="p${i}">${p}</span></label>`).join('')}</div></div>
      <div class="row"><label>期限</label><span class="inline"><input type="date" name="dd" value="${dd || ''}"><span class="due-time ${dd ? '' : 'hidden'}">${timeSelect('dt', dt)}</span>
        <button type="button" class="link ${dd ? '' : 'hidden'}" data-clear="dd">クリア</button></span></div>
      <div class="row"><label>やる日</label><span class="inline"><input type="date" name="doDate" value="${t.doDate || ''}">
        <button type="button" class="link ${t.doDate ? '' : 'hidden'}" data-clear="doDate">クリア</button></span></div>
      <div class="repeat-box ${dd ? '' : 'hidden'}">${repeatFields(t.repeat)}</div>
      <div class="row"><label>長期タスク</label><select name="longLead">${options(LEADS, t.longLead || 0)}</select></div>
      <div class="row"><label>ついで</label><input name="context" value="${esc(t.context)}" placeholder="例: 駅前, 学校（予定と一致したら提案）" autocomplete="off"></div>
      <div class="row top"><label>通知<br><small>期限の</small></label><div>${remEditor(t.reminders)}</div></div>
      <textarea name="memo" placeholder="メモ・詳細" rows="4">${esc(t.memo)}</textarea>
      <div class="actions">
        ${isNew ? '' : '<button type="button" class="danger" data-del>削除</button><button type="button" data-to-cal>カレンダーへ</button>'}
        <span class="sp"></span><button class="primary">保存</button>
      </div>
    </form>`);
  const f = $('form', m.el);
  bindRem(f);
  f.dd.addEventListener('input', () => {
    $('.due-time', f).classList.toggle('hidden', !f.dd.value);
    $('.repeat-box', f).classList.toggle('hidden', !f.dd.value);
  });
  // 期限・やる日の「クリア」（日付が入っているときだけ出す。iPhone の日付欄は自分で空にできないため）
  for (const b of $$('[data-clear]', f)) {
    const inp = f.elements[b.dataset.clear];
    const show = () => b.classList.toggle('hidden', !inp.value);
    inp.addEventListener('input', show);
    inp.addEventListener('change', show);
    b.addEventListener('click', () => { inp.value = ''; inp.dispatchEvent(new Event('input')); });
  }
  if (isNew) setTimeout(() => f.elements.title.focus(), 50);

  f.addEventListener('submit', e => {
    e.preventDefault();
    const due = f.dd.value ? `${f.dd.value}T${f.dt.value}` : '';
    const rep = due ? { freq: f.freq.value, interval: Math.max(1, +f.interval.value || 1) } : { freq: 'none', interval: 1 };
    const next = {
      ...t, title: f.elements.title.value.trim(), tabId: f.tabId.value, priority: +f.priority.value, due, doDate: f.doDate.value,
      repeat: rep, longLead: +f.longLead.value, context: f.context.value.trim(), memo: f.memo.value, reminders: readRem(f),
    };
    if (next.due !== t.due) delete next.hiddenUntil;
    S.upsertTodo(next);
    m.close();
    toast('todoを保存しました');
  });
  $('[data-del]', f)?.addEventListener('click', async () => {
    const rep = t.repeat?.freq && t.repeat.freq !== 'none' && t.due;
    const v = rep
      ? await choose('繰り返しtodoを削除します', [['skip', '今回分だけ消す（期限後に復活）', 'danger'], ['all', '完全に削除', 'danger']])
      : await choose(`「${esc(t.title)}」を削除しますか？`, [['all', '削除', 'danger']]);
    if (!v) return;
    S.deleteTodo(t.id, v === 'skip');
    m.close();
  });
  $('[data-to-cal]', f)?.addEventListener('click', () => {
    m.close();
    const day = t.doDate || (t.due || '').slice(0, 10) || ymd(new Date());
    openEventForm(null, { date: day });
    setTimeout(() => {
      const ef = $('.modal form');
      if (!ef) return;
      ef.elements.title.value = t.title;
      ef.memo.value = t.memo || '';
    }, 0);
  });
}

/* ================= Today's Path ================= */
const evTime = o => o.ev.allDay ? '終日' : `${hm(o.start)}<small>–${hm(o.end)}</small>`;
const todoLine = (t, chip) => `
  <li class="pt p${t.priority || 0}">
    <button class="chk" data-act="done" data-id="${t.id}" aria-label="完了"></button>
    <span class="t" data-act="edit-todo" data-id="${t.id}">${esc(t.title)}</span>${chip || ''}
  </li>`;
const dueChip = t => { const r = U.relDue(parse(t.due)); return `<span class="chip ${r.level}">${r.text}</span>`; };

// 一日の予定を時間軸に並べる（空き時間・重なり・締切・現在時刻が一目で分かる）
const PX_PER_HOUR = 36;
function timeline(p, now) {
  const day = p.day;
  const allDay = p.events.filter(o => o.ev.allDay);
  const segs = p.events.filter(o => !o.ev.allDay).map(o => ({
    o, s: Math.max(0, (o.start - day) / 60000), e: Math.min(1440, Math.max((o.end - day) / 60000, (o.start - day) / 60000 + 15)),
  })).sort((a, b) => a.s - b.s || b.e - a.e);
  const deadlines = p.dueSoon.filter(t => (t.due || '').startsWith(ymd(day)))
    .map(t => ({ t, m: (parse(t.due) - day) / 60000 }));

  // 重なる予定は横に並べる（重なりのまとまりごとに列数を決める）
  let group = [], groupEnd = -1;
  const flush = () => { const n = Math.max(...group.map(g => g.lane)) + 1; group.forEach(g => { g.n = n; }); group = []; };
  for (const g of segs) {
    if (group.length && g.s >= groupEnd) flush();
    g.lane = 0;
    while (group.some(x => x.lane === g.lane && x.e > g.s)) g.lane++;
    group.push(g);
    groupEnd = Math.max(groupEnd, g.e);
  }
  if (group.length) flush();

  const marks = [...segs.flatMap(g => [g.s, g.e]), ...deadlines.map(d => d.m)];
  const from = marks.length ? Math.max(0, Math.floor(Math.min(...marks) / 60) * 60 - 60) : 8 * 60;
  const to = marks.length ? Math.min(1440, Math.ceil(Math.max(...marks) / 60) * 60 + 60) : 18 * 60;
  const y = m => (m - from) * PX_PER_HOUR / 60;

  let html = allDay.length ? `<div class="tl-allday">${allDay.map(o =>
    `<span class="tl-ad" ${cs(o.ev)} data-act="edit-event" data-id="${o.ev.id}" data-occ="${ymd(day)}">${esc(o.ev.title)}</span>`).join('')}</div>` : '';
  if (!segs.length && !deadlines.length) return html;

  html += `<div class="tl" style="height:${y(to)}px">`;
  for (let m = from; m <= to; m += 60) html += `<div class="tl-hour" style="top:${y(m)}px"><span>${m / 60}:00</span></div>`;
  for (const g of segs) {
    const o = g.o;
    const h = Math.max(20, y(g.e) - y(g.s) - 2);
    html += `<div class="tl-ev ${h < 30 ? 'short' : ''} ${p.conflicts.has(o.key) ? 'conflict' : ''}"
      style="top:${y(g.s)}px;height:${h}px;--l:${g.lane};--n:${g.n};${colorVars(o.ev)}" data-act="edit-event" data-id="${o.ev.id}" data-occ="${ymd(o.start)}">
      <b>${esc(o.ev.title)}</b>
      <small>${hm(o.start)}–${hm(o.end)}${o.ev.location ? ` @${esc(o.ev.location)}` : ''}</small>
      ${p.conflicts.has(o.key) ? '<span class="chip over">重複</span>' : ''}
      ${S.isWork(o.ev) ? `<span class="chip pay">${U.yen(S.shiftPay(o).pay)}</span>` : ''}
    </div>`;
  }
  for (const d of deadlines)
    html += `<div class="tl-due" style="top:${y(d.m)}px" data-act="edit-todo" data-id="${d.t.id}"><span>締切 ${hm(parse(d.t.due))} ${esc(d.t.title)}</span></div>`;
  if (now) {
    const nm = (now - day) / 60000;
    if (nm >= from && nm <= to) html += `<div class="tl-now" style="top:${y(nm)}px"></div>`;
  }
  return `${html}</div>`;
}

function renderPath() {
  const now = new Date();
  const target = pathTarget || startOfDay(now);
  const isToday = ymd(target) === ymd(now);
  const p = S.buildPath(target, now);
  const s = state.settings;
  const todayKey = ymd(now);
  const showCheck = s.dailyCheck && hm(now) >= s.checkTime && state.meta.checkDone !== todayKey;
  const doneToday = state.todos.filter(t => t.doneAt && ymd(new Date(t.doneAt)) === todayKey);
  const todayEvents = S.occurrencesIn(startOfDay(now), addDays(startOfDay(now), 1));

  const card = (title, body, cls = '') => `<section class="card ${cls}"><h3>${title}</h3>${body}</section>`;
  const empty = txt => `<p class="empty">${txt}</p>`;

  let html = `
    <header class="vh">
      <div><h1>Today's Path</h1><div class="sub">${isToday ? '今日' : ymd(target) === ymd(addDays(now, 1)) ? '明日' : ''} ${U.fmtDate(target)}
        ${holidayName(ymd(target)) ? `<span class="hol-name">${holidayName(ymd(target))}</span>` : ''}</div></div>
      <div class="seg small">
        <button data-act="pt" data-v="-1">‹</button>
        <button data-act="pt" data-v="today" class="${isToday ? 'on' : ''}">今日</button>
        <button data-act="pt" data-v="tomorrow" class="${ymd(target) === ymd(addDays(now, 1)) ? 'on' : ''}">明日</button>
        <button data-act="pt" data-v="1">›</button>
      </div>
    </header>`;

  if (state.inbox.length) {
    html += card(`確認待ち <span class="count">${state.inbox.length}</span>`, `<ul class="inbox">${state.inbox.map(x => {
      const d = x.data;
      const when = x.kind === 'event' ? U.fmtDateTime(parse(d.start)) : d.due ? `期限 ${U.fmtDateTime(parse(d.due))}` : '';
      return `<li><span class="kind">${x.replaces ? '変更' : x.kind === 'event' ? '予定' : 'todo'}</span>
        <div class="body"><b>${esc(d.title)}</b> <small>${when}</small>${x.reason ? `<div class="reason">${esc(x.reason)}</div>` : ''}
          ${srcLine(x)}</div>
        <button class="primary small" data-act="approve" data-id="${x.id}">${x.replaces ? '変更する' : '追加'}</button>
        <button class="small" data-act="reject" data-id="${x.id}">不要</button></li>`;
    }).join('')}</ul>`, 'inbox-card');
  }

  const added = S.claudeAdded();
  if (added.length) {
    html += card(`Claude が追加しました <span class="count">${added.length}</span>
      <button class="small push-right" data-act="seen-all">すべて確認済みにする</button>`, `<ul class="inbox added">${added.map(({ kind, item: x }) => {
      const when = kind === 'event' ? (x.allDay ? U.fmtDate(parse(x.start)) + (x.end && x.end !== x.start ? `〜${U.fmtDate(parse(x.end))}` : '') : U.fmtDateTime(parse(x.start)))
        : x.due ? `期限 ${U.fmtDateTime(parse(x.due))}` : x.doDate ? `やる日 ${U.fmtDate(parse(x.doDate))}` : '';
      return `<li><span class="kind" ${kind === 'event' ? cs(x) : ''}>${kind === 'event' ? '予定' : 'todo'}</span>
        <div class="body" data-act="${kind === 'event' ? 'edit-event' : 'edit-todo'}" data-id="${x.id}"><b>${esc(x.title)}</b> <small>${when}</small>
          ${srcLine(x)}</div>
        <button class="small" data-act="seen" data-id="${x.id}">確認済み</button></li>`;
    }).join('')}</ul>`, 'inbox-card');
  }

  if (showCheck) {
    html += card('今日の記入漏れチェック', `
      <p class="muted">今日あった予定 ${todayEvents.length}件 ／ 完了したtodo ${doneToday.length}件。書き忘れた予定ややることはありませんか？</p>
      <div class="actions"><button data-act="add-event" data-day="${todayKey}">予定を追加</button><button data-act="add-todo">todoを追加</button>
      <span class="sp"></span><button class="primary" data-act="check-ok">漏れなし</button></div>`, 'check-card');
  }

  html += card('一日の流れ', p.events.length ? timeline(p, isToday ? now : null) : empty('予定はありません'));

  html += card('期限が迫っている', p.dueSoon.length ? `<ul class="plist">${p.dueSoon.map(t => todoLine(t, dueChip(t))).join('')}</ul>` : empty('なし'));
  if (p.doToday.length) html += card('この日にやる', `<ul class="plist">${p.doToday.map(t => todoLine(t, t.due ? dueChip(t) : '')).join('')}</ul>`);
  if (p.alongside.length) html += card('ついでにできそう', `<ul class="plist">${p.alongside.map(a =>
    todoLine(a.todo, `<span class="chip along">${esc(a.occ.ev.title)}${a.occ.ev.allDay ? '' : ` ${hm(a.occ.start)}`} のついで</span>`)).join('')}</ul>`);
  if (p.longTerm.length) html += card('長期的なタスク', `<ul class="plist">${p.longTerm.map(a =>
    todoLine(a.todo, `<span class="chip long">あと${a.left}日</span>`)).join('')}</ul>`);

  html += isToday
    ? `<button class="next-day" data-act="pt" data-v="tomorrow">明日の Today's Path を見る <span>›</span></button>`
    : `<button class="next-day" data-act="pt" data-v="today"><span>‹</span> 今日の Today's Path に戻る</button>`;

  $('#view').innerHTML = html;

  if (state.meta.badge && document.visibilityState === 'visible') { state.meta.badge = 0; S.save(); updateBadge(); }
}

/* ================= カレンダー（縦に連続） ================= */
const weekStartOf = d => addDays(startOfDay(d), -((d.getDay() - state.settings.weekStart + 7) % 7));

// 1 マスに出せる行数（帯と時間ありの予定の合計）。それ以上は「+n」
const CELL_ROWS = 4;
const lastDayOf = o => startOfDay(o.end > o.start ? new Date(o.end - 1) : o.start);

function weeksHtml(first, n) {
  const occs = S.occurrencesIn(first, addDays(first, 7 * n));
  const todayKey = ymd(new Date());
  let html = '';
  for (let w = 0; w < n; w++) {
    const ws = addDays(first, w * 7), we = addDays(ws, 7);
    const inWeek = occs.filter(o => o.start < we && lastDayOf(o) >= ws);
    // 終日の予定と、日をまたぐ予定は帯にする（週の中でつながった 1 本の帯）
    const isBar = o => o.ev.allDay || ymd(lastDayOf(o)) !== ymd(o.start);
    const bars = inWeek.filter(isBar).map(o => ({
      o, c0: Math.max(0, U.daysBetween(ws, o.start)), c1: Math.min(6, U.daysBetween(ws, lastDayOf(o))),
    })).sort((a, b) => a.c0 - b.c0 || (b.c1 - b.c0) - (a.c1 - a.c0) || (b.o.ev.allDay - a.o.ev.allDay));
    const lanes = [];
    for (const b of bars) {
      b.lane = lanes.findIndex(end => end < b.c0);
      if (b.lane < 0) { b.lane = lanes.length; lanes.push(-1); }
      lanes[b.lane] = b.c1;
    }
    const shown = Math.min(lanes.length, CELL_ROWS - 1);
    const hiddenBars = Array(7).fill(0);
    for (const b of bars) if (b.lane >= shown) for (let c = b.c0; c <= b.c1; c++) hiddenBars[c]++;

    const mid = Array.from({ length: 7 }, (_, i) => addDays(ws, i)).find(d => d.getDate() === 15);
    html += `<div class="week" style="--lanes:${shown}">${mid ? `<div class="wm" aria-hidden="true"><span>${mid.getMonth() + 1}</span><small>${mid.getFullYear()}</small></div>` : ''}`;
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      const k = ymd(d);
      const hol = holidayName(k);
      const timed = inWeek.filter(o => !isBar(o) && ymd(o.start) === k);
      // 帯で使っていない行に、時間ありの予定を入れる
      const free = Math.max(1, CELL_ROWS - shown);
      const more = hiddenBars[i] + Math.max(0, timed.length - free);
      const dow = d.getDay();
      const cls = [d.getMonth() % 2 ? 'odd' : '', k === todayKey ? 'today' : '', dow === 0 ? 'sun' : dow === 6 ? 'sat' : '', hol ? 'hol' : '',
        d.getDate() <= 7 ? 'mtop' : '', d.getDate() === 1 ? 'mfirst' : ''].join(' ');
      html += `<div class="day ${cls}" data-act="day" data-day="${k}" data-ym="${d.getFullYear()}年${d.getMonth() + 1}月">
        <div class="dn">${d.getDate() === 1 ? `<b>${d.getMonth() + 1}月</b>` : ''}<span>${d.getDate()}</span>${hol ? `<em>${hol}</em>` : ''}</div>
        <div class="bar-space"></div>
        ${timed.slice(0, free).map(o => `<div class="ev" ${cs(o.ev)}><i>${hm(o.start)}</i>${esc(o.ev.title)}</div>`).join('')}
        ${more ? `<div class="more">+${more}</div>` : ''}
      </div>`;
    }
    html += `<div class="bars" aria-hidden="true">${bars.filter(b => b.lane < shown).map(b => {
      const contL = b.o.start < ws, contR = lastDayOf(b.o) >= we;
      return `<div class="bar ${b.o.ev.allDay ? 'ad' : 'tm'} ${contL ? 'cl' : ''} ${contR ? 'cr' : ''}"
        style="grid-column:${b.c0 + 1}/${b.c1 + 2};grid-row:${b.lane + 1};${colorVars(b.o.ev)}">${b.o.ev.allDay ? '' : `<i>${hm(b.o.start)}</i>`}${esc(b.o.ev.title)}</div>`;
    }).join('')}</div></div>`;
  }
  return html;
}

function renderCal() {
  const prevBody = $('#calBody');
  const keep = prevBody ? prevBody.scrollTop : cal?.scroll;
  if (!cal) cal = { first: addDays(weekStartOf(new Date()), -7 * 26), weeks: 80, jump: ymd(new Date()) };
  const wd = Array.from({ length: 7 }, (_, i) => U.WD[(i + state.settings.weekStart) % 7]);
  $('#view').innerHTML = `
    <div class="cal">
      <div class="cal-head">
        <h1 id="calMonth"></h1>
        <input type="search" id="calSearch" placeholder="予定を検索" value="${esc(calQuery)}">
        <button data-act="cal-today">今日</button>
        <button class="primary" data-act="add-event">＋</button>
      </div>
      <div class="wd">${wd.map(w => `<span class="${w === '日' ? 'sun' : w === '土' ? 'sat' : ''}">${w}</span>`).join('')}</div>
      <div class="cal-body" id="calBody">${weeksHtml(cal.first, cal.weeks)}</div>
      <div class="search-results hidden" id="searchResults"></div>
    </div>`;
  const body = $('#calBody');
  if (cal.jump) { scrollToDay(cal.jump, false); cal.jump = null; }
  else if (keep != null) body.scrollTop = keep;
  updateMonthLabel();
  body.addEventListener('scroll', onCalScroll, { passive: true });
  const si = $('#calSearch');
  si.addEventListener('input', () => { calQuery = si.value; renderSearch(); });
  renderSearch();
}

function scrollToDay(k, smooth = true) {
  const d = parse(k);
  const end = addDays(cal.first, 7 * cal.weeks);
  if (d < cal.first || d >= end) {
    cal.first = addDays(weekStartOf(d), -7 * 26);
    cal.weeks = 80;
    $('#calBody').innerHTML = weeksHtml(cal.first, cal.weeks);
  }
  const el = $(`#calBody [data-day="${k}"]`);
  if (!el) return;
  const body = $('#calBody');
  body.scrollTo({ top: el.parentElement.offsetTop - el.parentElement.offsetHeight, behavior: smooth ? 'smooth' : 'auto' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1200);
}

function onCalScroll() {
  const body = $('#calBody');
  const CHUNK = 12;
  if (body.scrollTop < 400) {
    cal.first = addDays(cal.first, -7 * CHUNK);
    cal.weeks += CHUNK;
    const h = body.scrollHeight;
    body.insertAdjacentHTML('afterbegin', weeksHtml(cal.first, CHUNK));
    body.scrollTop += body.scrollHeight - h;
  } else if (body.scrollTop + body.clientHeight > body.scrollHeight - 400) {
    body.insertAdjacentHTML('beforeend', weeksHtml(addDays(cal.first, 7 * cal.weeks), CHUNK));
    cal.weeks += CHUNK;
  }
  cal.scroll = body.scrollTop;
  updateMonthLabel();
}

function updateMonthLabel() {
  const body = $('#calBody');
  const top = body.getBoundingClientRect().top + 40;
  const week = $$('.week', body).find(w => w.getBoundingClientRect().bottom > top);
  if (week) $('#calMonth').textContent = $$('.day', week)[3].dataset.ym;
}

function renderSearch() {
  const box = $('#searchResults');
  const q = calQuery.trim().toLowerCase();
  box.classList.toggle('hidden', !q);
  if (!q) return;
  const now = new Date();
  const hits = S.occurrencesIn(addDays(now, -730), addDays(now, 730)).filter(o =>
    [o.ev.title, o.ev.location, o.ev.memo, ...(o.ev.tags || [])].join(' ').toLowerCase().includes(q));
  const future = hits.filter(o => o.end >= now);
  const past = hits.filter(o => o.end < now).reverse();
  const row = o => `<li data-act="search-hit" data-day="${ymd(o.start)}" data-id="${o.ev.id}">
      <span class="d">${o.start.getFullYear()}/${U.fmtDate(o.start)}</span><span class="t">${esc(o.ev.title)}</span>
      <small>${o.ev.allDay ? '終日' : hm(o.start)}${o.ev.location ? ` @${esc(o.ev.location)}` : ''}</small></li>`;
  box.innerHTML = hits.length
    ? `${future.length ? `<h4>これから</h4><ul>${future.slice(0, 50).map(row).join('')}</ul>` : ''}${past.length ? `<h4>過去</h4><ul>${past.slice(0, 50).map(row).join('')}</ul>` : ''}`
    : '<p class="empty">見つかりませんでした</p>';
}

function openDay(k) {
  const d = parse(k);
  const occs = S.occurrencesIn(d, addDays(d, 1));
  const todos = state.todos.filter(t => !t.done && S.isVisible(t) && ((t.due || '').startsWith(k) || t.doDate === k));
  const conflicts = S.conflictKeys(occs);
  const pay = occs.filter(o => S.isWork(o.ev)).reduce((a, o) => a + S.shiftPay(o).pay, 0);
  const m = modal(`
    <div class="mhead"><h2>${d.getFullYear()}年 ${U.fmtDate(d)}${holidayName(k) ? ` <span class="hol-name">${holidayName(k)}</span>` : ''}</h2><button type="button" class="icon" data-close>×</button></div>
    <ul class="plist">${occs.map(o => `
      <li class="pe ${o.ev.allDay ? 'ad' : ''}" ${cs(o.ev)} data-act="edit-event" data-id="${o.ev.id}" data-occ="${k}">
        <span class="time">${evTime(o)}</span><span class="t">${esc(o.ev.title)}${o.ev.location ? `<small class="loc"> @${esc(o.ev.location)}</small>` : ''}</span>
        ${conflicts.has(o.key) ? '<span class="chip over">重複</span>' : ''}
      </li>`).join('') || '<p class="empty">予定はありません</p>'}</ul>
    ${pay ? `<p class="muted">この日のバイト代 ${U.yen(pay)}</p>` : ''}
    ${todos.length ? `<h3 class="sub-h">todo</h3><ul class="plist">${todos.map(t => todoLine(t, t.due?.startsWith(k) ? `<span class="chip">期限 ${t.due.slice(11)}</span>` : '<span class="chip">やる日</span>')).join('')}</ul>` : ''}
    <div class="actions"><button data-act="add-todo-day" data-day="${k}">todoを追加</button><span class="sp"></span><button class="primary" data-act="add-event" data-day="${k}">予定を追加</button></div>`);
  m.el.addEventListener('click', e => { if (e.target.closest('[data-act]')) setTimeout(m.close, 0); });
}

/* ================= ToDo ================= */
function sortTodos(list) {
  const by = state.settings.todoSort;
  const dueVal = t => t.due ? parse(t.due).getTime() : Infinity;
  const cmp = {
    manual: (a, b) => (a.order ?? 0) - (b.order ?? 0),
    due: (a, b) => dueVal(a) - dueVal(b),
    priority: (a, b) => (b.priority || 0) - (a.priority || 0) || dueVal(a) - dueVal(b),
    doDate: (a, b) => (a.doDate || '9999').localeCompare(b.doDate || '9999') || dueVal(a) - dueVal(b),
    created: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
    title: (a, b) => a.title.localeCompare(b.title, 'ja'),
  }[by] || ((a, b) => 0);
  return [...list].sort(cmp);
}

function todoRow(t, { drag } = {}) {
  const meta = [];
  if (t.due) { const r = U.relDue(parse(t.due)); meta.push(`<span class="chip ${r.level}">期限 ${r.text}</span>`); }
  if (t.doDate) meta.push(`<span class="chip dodate">やる日 ${U.fmtDate(parse(t.doDate))}</span>`);
  if (t.repeat?.freq && t.repeat.freq !== 'none') meta.push(`<span class="chip">↻ ${t.repeat.interval > 1 ? t.repeat.interval : ''}${S.FREQ_LABEL[t.repeat.freq]}ごと</span>`);
  if (t.longLead) meta.push('<span class="chip long">長期</span>');
  if (t.reminders?.length) meta.push('<span class="chip">🔔</span>');
  if (t.memo) meta.push('<span class="chip">メモ</span>');
  if (todoTab === 'all') meta.push(`<span class="chip tabname">${esc(state.tabs.find(x => x.id === t.tabId)?.name || '')}</span>`);
  return `<li class="todo p${t.priority || 0} ${t.done ? 'done' : ''}" data-id="${t.id}">
    <button class="chk" data-act="${t.done ? 'undone' : 'done'}" data-id="${t.id}" aria-label="完了"></button>
    <div class="body" data-act="edit-todo" data-id="${t.id}"><div class="t">${esc(t.title)}</div>${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}</div>
    ${drag ? '<span class="handle" aria-label="並べ替え">⠿</span>' : ''}
  </li>`;
}

function renderTodo() {
  if (todoTab !== 'all' && !state.tabs.some(t => t.id === todoTab)) todoTab = 'all';
  const now = new Date();
  const inTab = t => todoTab === 'all' || t.tabId === todoTab;
  const active = sortTodos(state.todos.filter(t => inTab(t) && !t.done && S.isVisible(t, now)));
  const waiting = state.todos.filter(t => inTab(t) && !t.done && !S.isVisible(t, now));
  const done = state.todos.filter(t => inTab(t) && t.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
  const manual = state.settings.todoSort === 'manual';
  $('#view').innerHTML = `
    <header class="vh"><h1>ToDo</h1>
      <select id="todoSort" class="small">${options([['manual', '手動'], ['due', '期限順'], ['priority', '優先度順'], ['doDate', 'やる日順'], ['created', '追加が新しい順'], ['title', '名前順']], state.settings.todoSort)}</select>
    </header>
    <nav class="tabs">
      <button class="${todoTab === 'all' ? 'on' : ''}" data-act="tab" data-id="all">すべて</button>
      ${state.tabs.map(t => `<button class="${todoTab === t.id ? 'on' : ''}" data-act="tab" data-id="${t.id}">${esc(t.name)}
        <small>${state.todos.filter(x => x.tabId === t.id && !x.done && S.isVisible(x, now)).length || ''}</small></button>`).join('')}
      <button data-act="tabs-edit" title="リストを編集">＋ / 編集</button>
    </nav>
    <ul class="todos" id="todoList">${active.map(t => todoRow(t, { drag: manual })).join('') || '<p class="empty">やることはありません</p>'}</ul>
    ${waiting.length ? `<details class="fold"><summary>繰り返し待機中（${waiting.length}）</summary><ul class="todos">${waiting.map(t =>
      `<li class="todo waiting"><div class="body" data-act="edit-todo" data-id="${t.id}"><div class="t">${esc(t.title)}</div>
       <div class="meta"><span class="chip">${U.fmtDateTime(parse(t.hiddenUntil))} 以降に復活（次の期限 ${U.fmtDate(parse(t.due))}）</span></div></div></li>`).join('')}</ul></details>` : ''}
    ${done.length ? `<details class="fold" ${showDone ? 'open' : ''} id="doneFold"><summary>完了（${done.length}）</summary>
      <ul class="todos">${done.slice(0, 100).map(t => todoRow(t)).join('')}</ul>
      <button class="link danger" data-act="clear-done">完了済みを削除</button></details>` : ''}
    <form id="quickAdd" class="quick"><input name="q" placeholder="＋ やることを入力して Enter" autocomplete="off" enterkeyhint="done"><button class="primary">追加</button></form>`;

  $('#todoSort').addEventListener('change', e => { state.settings.todoSort = e.target.value; S.save(); });
  $('#doneFold')?.addEventListener('toggle', e => { showDone = e.target.open; });
  $('#quickAdd').addEventListener('submit', e => {
    e.preventDefault();
    const title = e.target.q.value.trim();
    if (!title) return;
    // 入力欄がリストの下にあるので、新しい todo も手動の並びでは一番下に入れる
    S.upsertTodo({ title, tabId: todoTab === 'all' ? state.tabs[0].id : todoTab, order: Math.max(0, ...state.todos.map(x => x.order ?? 0)) + 1 });
    $('#quickAdd input').focus();
  });
  if (manual) bindDrag($('#todoList'));
}

// ハンドルをつかんで並べ替え（マウス・タッチ共通）
function bindDrag(ul) {
  ul.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.handle');
    if (!handle) return;
    e.preventDefault();
    const li = handle.closest('li');
    li.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    const move = ev => {
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('li.todo');
      if (!over || over === li || over.parentNode !== ul) return;
      const r = over.getBoundingClientRect();
      ev.clientY < r.top + r.height / 2 ? over.before(li) : over.after(li);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      li.classList.remove('dragging');
      const ids = $$('li.todo', ul).map(x => x.dataset.id);
      // 他タブの項目と順番が混ざらないよう、表示中の項目が持っていた order 値を並べ直して割り当てる
      const orders = ids.map(id => state.todos.find(t => t.id === id).order ?? 0).sort((a, b) => a - b);
      ids.forEach((id, i) => { state.todos.find(t => t.id === id).order = orders[i] + i * 1e-6; });
      S.save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
}

function openTabsEditor() {
  const draw = () => state.tabs.map((t, i) => `<li data-i="${i}"><input value="${esc(t.name)}" data-name="${t.id}">
      <button type="button" class="icon" data-up="${i}" ${i ? '' : 'disabled'}>↑</button>
      <button type="button" class="icon danger" data-rm="${t.id}" ${state.tabs.length > 1 ? '' : 'disabled'}>削除</button></li>`).join('');
  const m = modal(`<div class="mhead"><h2>リスト（タブ）を編集</h2><button type="button" class="icon" data-close>×</button></div>
    <ul class="tabedit">${draw()}</ul>
    <form class="quick" id="newTab"><input name="n" placeholder="新しいリスト名（例: 学校, バイト, 買い物）"><button class="primary">追加</button></form>`);
  const redraw = () => { $('.tabedit', m.el).innerHTML = draw(); };
  m.el.addEventListener('change', e => {
    const id = e.target.dataset.name;
    if (id) { state.tabs.find(t => t.id === id).name = e.target.value.trim() || '無題'; S.save(); }
  });
  m.el.addEventListener('click', async e => {
    const up = e.target.closest('[data-up]')?.dataset.up;
    if (up) { const i = +up; [state.tabs[i - 1], state.tabs[i]] = [state.tabs[i], state.tabs[i - 1]]; S.save(); redraw(); }
    const rm = e.target.closest('[data-rm]')?.dataset.rm;
    if (rm) {
      const n = state.todos.filter(t => t.tabId === rm).length;
      const ok = await choose(`このリストを削除しますか？${n ? `<br>中のtodo ${n}件は「${esc(state.tabs.find(t => t.id !== rm).name)}」に移動します。` : ''}`, [['y', '削除', 'danger']]);
      if (!ok) return;
      state.tabs = state.tabs.filter(t => t.id !== rm);
      state.todos.forEach(t => { if (t.tabId === rm) t.tabId = state.tabs[0].id; });
      S.save(); redraw();
    }
  });
  $('#newTab', m.el).addEventListener('submit', e => {
    e.preventDefault();
    const n = e.target.n.value.trim();
    if (!n) return;
    const id = U.uid('tab');
    state.tabs.push({ id, name: n });
    todoTab = id;
    S.save(); redraw();
    e.target.reset();
  });
}

/* ================= 給料 ================= */
let payMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
function renderPay() {
  const from = payMonth, to = U.addMonths(payMonth, 1);
  const r = S.payInRange(from, to);
  const yr = S.payInRange(new Date(from.getFullYear(), 0, 1), new Date(from.getFullYear() + 1, 0, 1));
  const now = new Date();
  const done = r.shifts.filter(x => x.end <= now);
  const h = min => `${Math.floor(min / 60)}時間${min % 60 ? `${Math.round(min % 60)}分` : ''}`;
  $('#view').innerHTML = `
    <header class="vh"><h1>給料</h1>
      <div class="seg small"><button data-act="pay-m" data-v="-1">‹</button><button data-act="pay-m" data-v="0">${from.getFullYear()}年${from.getMonth() + 1}月</button><button data-act="pay-m" data-v="1">›</button></div>
    </header>
    <section class="card pay-sum">
      <div class="big">${U.yen(r.pay)}</div>
      <div class="muted">${r.shifts.length}回 ・ ${h(r.minutes)}（うち勤務済み ${U.yen(done.reduce((a, x) => a + x.pay, 0))}）</div>
      <div class="muted small">${from.getFullYear()}年の合計 ${U.yen(yr.pay)}</div>
    </section>
    <section class="card"><h3>シフト</h3>
      ${r.shifts.length ? `<ul class="shifts">${r.shifts.map(x => `
        <li data-act="edit-event" data-id="${x.ev.id}" data-occ="${ymd(x.start)}" class="${x.end <= now ? 'past' : ''}">
          <span class="d">${U.fmtDate(x.start)}</span>
          <span class="t">${hm(x.start)}–${hm(x.end)} <small>${esc(x.ev.title)}</small></span>
          <span class="h">${h(x.workMin)}${x.nightMin ? `<small> 深夜${h(x.nightMin)}</small>` : ''}</span>
          <span class="w">${U.yen(x.wage)}/h</span><b>${U.yen(x.pay)}</b>
        </li>`).join('')}</ul>`
      : `<p class="empty">この月のシフトはありません。予定に「${esc(state.settings.workTag)}」タグを付けると時給を入力でき、ここで集計されます。</p>`}
    </section>`;
}

/* ================= 設定 ================= */
function renderSettings() {
  const s = state.settings;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  $('#view').innerHTML = `
    <header class="vh"><h1>設定</h1></header>
    ${syncCard()}
    <form id="settings" class="form card">
      <h3>Today's Path</h3>
      <div class="row"><label>朝の通知（今日のPath）</label>${timeSelect('morningTime', s.morningTime)}</div>
      <div class="row"><label>夜の通知（明日のPath）</label>${timeSelect('eveningTime', s.eveningTime)}</div>
      <div class="row"><label>期限が迫っている</label><span class="inline"><input type="number" class="num" name="nearDueDays" min="0" max="14" value="${s.nearDueDays}">日以内</span></div>
      <h3>記入漏れチェック</h3>
      <label class="check"><input type="checkbox" name="dailyCheck" ${s.dailyCheck ? 'checked' : ''}> 毎日確認する</label>
      <div class="row"><label>確認する時刻</label>${timeSelect('checkTime', s.checkTime)}</div>
      <h3>カレンダー</h3>
      <div class="row"><label>週の始まり</label><select name="weekStart">${options([[0, '日曜日'], [1, '月曜日']], s.weekStart)}</select></div>
      <h3>アルバイト</h3>
      <div class="row"><label>バイト用タグ名</label><input name="workTag" value="${esc(s.workTag)}"></div>
      <div class="row"><label>標準の時給</label><span class="inline"><input type="number" class="num w" name="defaultWage" step="10" value="${s.defaultWage}">円</span></div>
      <label class="check"><input type="checkbox" name="nightPremium" ${s.nightPremium ? 'checked' : ''}> 深夜割増（22時〜5時 25%）を計算する</label>
    </form>

    ${tagsCard()}

    <section class="card">
      <h3>通知</h3>
      <p class="muted small">状態: ${{ granted: '許可済み', denied: '拒否（端末の設定から許可してください）', default: '未設定', unsupported: 'この環境では未対応（iPhoneはホーム画面に追加したアプリから許可）' }[perm]}</p>
      ${perm === 'default' && !Push.pushSupported() ? '<button data-act="notif-perm" class="primary">通知を許可する</button>' : ''}
      ${pushRow()}
      <p class="muted small">予定・todoごとの通知は各編集画面で何個でも追加できます。下は時刻を決めて鳴らす自由な通知です。</p>
      <ul class="alarms">${s.alarms.map(a => `
        <li data-id="${a.id}">
          <label class="switch"><input type="checkbox" data-k="on" ${a.on ? 'checked' : ''}><span></span></label>
          <input data-k="label" value="${esc(a.label)}" placeholder="内容">
          <span>${timeSelect('', a.time).replace('<select name="">', '<select data-k="time">')}</span>
          <span class="days">${U.WD.map((w, i) => `<label><input type="checkbox" data-day="${i}" ${a.days.includes(i) ? 'checked' : ''}><span>${w}</span></label>`).join('')}</span>
          <button class="icon danger" data-act="alarm-del" data-id="${a.id}">×</button>
        </li>`).join('')}</ul>
      <button data-act="alarm-add">＋ 通知を追加</button>
    </section>

    ${backupCard()}`;

  $('#authForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.currentTarget;
    const mode = e.submitter?.dataset.auth || 'signin';
    const msg = $('#authMsg');
    $$('button', f).forEach(b => { b.disabled = true; });
    msg.textContent = mode === 'signup' ? '登録しています…' : 'ログインしています…';
    try {
      if (mode === 'signup') {
        const r = await Sync.signUp(f.email.value.trim(), f.pw.value);
        msg.textContent = r.needsConfirm ? '確認メールを送りました。メール内のリンクを押してから「ログイン」してください。' : '登録しました';
      } else {
        await Sync.signIn(f.email.value.trim(), f.pw.value);
      }
    } catch (err) { msg.textContent = err.message; }
    $$('button', f).forEach(b => { b.disabled = false; });
  });
  $('#settings').addEventListener('change', e => {
    const f = e.currentTarget;
    Object.assign(s, {
      morningTime: f.morningTime.value, eveningTime: f.eveningTime.value, checkTime: f.checkTime.value,
      nearDueDays: Math.max(0, +f.nearDueDays.value || 0), dailyCheck: f.dailyCheck.checked,
      weekStart: +f.weekStart.value, workTag: f.workTag.value.trim() || 'バイト',
      defaultWage: +f.defaultWage.value || 0, nightPremium: f.nightPremium.checked,
    });
    if (e.target.name === 'weekStart') cal = null;
    S.save();
  });
  bindTagsCard();
  $('.alarms').addEventListener('change', e => {
    const li = e.target.closest('li');
    const a = s.alarms.find(x => x.id === li.dataset.id);
    if (e.target.dataset.day != null) a.days = $$('[data-day]', li).filter(x => x.checked).map(x => +x.dataset.day);
    else if (e.target.dataset.k === 'on') a.on = e.target.checked;
    else a[e.target.dataset.k] = e.target.value;
    S.save();
  });
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const ok = await choose('現在のデータを読み込んだデータで置き換えますか？<br><small>今のデータは置き換える前にバックアップします。</small>', [['y', '置き換える', 'danger']]);
      if (ok) { await beforeReplace('before-import'); S.replaceAll(data); toast('読み込みました'); }
    } catch { toast('読み込めませんでした'); }
  });
}

/* ---------- タグ ---------- */
function tagsCard() {
  const count = name => state.events.filter(e => e.tags?.includes(name)).length;
  const row = (name, color, registered) => `
    <li data-tag="${esc(name)}">
      <button class="swatch" data-act="tag-color" data-v="${esc(name)}" style="--c:${color || S.DEFAULT_COLOR}" aria-label="色を変える"></button>
      <input value="${esc(name)}" data-tag-name="${esc(name)}" ${registered ? '' : 'disabled'}>
      <small>${count(name)}件${name === state.settings.workTag ? '・バイト' : ''}${registered ? '' : '・色未設定'}</small>
      <button class="icon danger" data-act="tag-del" data-v="${esc(name)}" aria-label="削除">削除</button>
    </li>`;
  return `
    <section class="card">
      <h3>タグと色</h3>
      <p class="muted small">予定の色はタグで決まります（タグが複数なら上にあるタグの色）。色の丸を押すと、一覧から選ぶか自由に色を決められます（あとからいつでも変更できます）。</p>
      <ul class="tagedit">${S.tagList().map(t => row(t.name, t.color, true)).join('')}${S.unregisteredTags().map(n => row(n, null, false)).join('')}</ul>
      <form class="quick" id="newTag"><input name="n" placeholder="新しいタグ（例: 学校, 部活, 試験）" autocomplete="off"><button class="primary">追加</button></form>
    </section>`;
}

// 新しいタグにおすすめする色（まだどのタグも使っていない色）
const nextColor = () => (S.PALETTE.find(([c]) => !S.tagList().some(t => t.color === c)) || S.PALETTE[17])[0];
// 色を選ぶ画面（一覧から選ぶ・自由に選ぶ）。選んだ色を返す（閉じたら null）
function chooseColor(name, cur) {
  return new Promise(resolve => {
    cur = (cur || S.DEFAULT_COLOR).toLowerCase();
    const m = modal(`<div class="mhead"><h2>「${esc(name)}」の色</h2><button type="button" class="icon" data-close>×</button></div>
      <div class="palette">${S.PALETTE.map(([c, l]) => `<button type="button" class="swatch big ${c === cur ? 'on' : ''}" data-c="${c}" style="--c:${c}" title="${l}"><span>${l}</span></button>`).join('')}</div>
      <div class="customcolor">
        <label>自由に選ぶ <input type="color" value="${cur}"></label>
        <span class="tchip on preview" style="--c:${cur}">${esc(name)}</span>
        <span class="sp"></span><button type="button" class="primary" data-ok>この色にする</button>
      </div>`);
    let done = false;
    const finish = c => { if (done) return; done = true; m.close(); resolve(c); };
    const inp = $('input[type=color]', m.el), pv = $('.preview', m.el);
    inp.addEventListener('input', () => pv.style.setProperty('--c', inp.value));
    m.el.addEventListener('click', e => {
      const c = e.target.closest('[data-c]')?.dataset.c;
      if (c) return finish(c);
      if (e.target.closest('[data-ok]')) finish(inp.value);
    });
    // ×・背景・Esc で閉じたとき
    new MutationObserver((_, o) => { if (!m.el.isConnected) { o.disconnect(); if (!done) { done = true; resolve(null); } } })
      .observe(document.body, { childList: true });
  });
}

async function pickColor(name) {
  const c = await chooseColor(name, S.tagColor(name));
  if (!c) return;
  const t = S.tagList().find(x => x.name === name);
  if (t) t.color = c; else (state.settings.tags ||= []).push({ name, color: c });
  S.save();
}

function bindTagsCard() {
  $('.tagedit')?.addEventListener('change', e => {
    const from = e.target.dataset.tagName;
    if (from == null) return;
    const to = e.target.value.replace(/,/g, '').trim();
    if (!to) { e.target.value = from; return; }
    S.renameTag(from, to);
  });
  $('#newTag')?.addEventListener('submit', e => {
    e.preventDefault();
    const n = e.target.n.value.replace(/,/g, '').trim();
    if (!n) return;
    if (S.tagColor(n)) return toast('同じ名前のタグがあります');
    chooseColor(n, nextColor()).then(c => {
      if (!c) return;
      S.registerTags([n], { [n]: c });
      S.save();
    });
  });
}

function pushRow() {
  if (!Push.pushSupported()) return '';
  if (Push.pushActive()) return `
    <p class="small">この端末: <b>アプリを閉じていても通知が届きます</b></p>
    <div class="actions"><button data-act="push-test">テスト通知（約1分後）</button><span class="sp"></span><button data-act="push-off">この端末で受け取らない</button></div>`;
  return `
    <p class="muted small">今はアプリを開いている間だけ通知します。閉じていても届くようにするには、ログインしてから下のボタンを押してください。</p>
    <button data-act="push-on" class="primary">閉じていても通知を受け取る</button>`;
}

/* ---------- バックアップ ---------- */
let serverBackups = null;   // null: まだ取得していない / 配列 / { error }
async function loadServerBackups() {
  try { serverBackups = await Sync.listBackups(); } catch (e) { serverBackups = { error: e.message || String(e) }; }
  if (view === 'settings') renderSettings();
}
const KIND = { auto: '自動', manual: '手動', daily: '自動', 'before-import': '読み込み前', 'before-restore': '復元前' };
const when = iso => { const d = new Date(iso); return `${U.fmtDate(d)} ${hm(d)}`; };

function backupCard() {
  const u = Sync.currentUser();
  if (u && serverBackups === null) { serverBackups = []; loadServerBackups(); }
  const server = !u ? '<p class="muted small">ログインすると、サーバーに毎日自動で保存されます。</p>'
    : serverBackups?.error ? `<p class="small danger">取得できませんでした: ${esc(serverBackups.error)}</p>`
    : serverBackups.length ? `<ul class="backups">${serverBackups.slice(0, 14).map(b => `
        <li><span>${when(b.created_at)}</span><small>${KIND[b.kind] || b.kind}・${b.count}件</small>
          <button class="small" data-act="restore-server" data-id="${b.id}">この時点に戻す</button></li>`).join('')}</ul>`
    : '<p class="muted small">まだありません</p>';
  const local = Backup.list();
  return `
    <section class="card">
      <h3>バックアップ</h3>
      <p class="muted small">間違えて消したときや同期の不具合のときに、前の状態へ戻せます。戻す前の状態も自動で保存されるので、戻したあとでも元に戻せます。</p>
      <h4>サーバー（毎日4時に自動・60日分）</h4>
      ${server}
      ${u ? '<button data-act="backup-now">今すぐバックアップ</button>' : ''}
      <h4>この端末（1日1回自動・7日分）</h4>
      ${local.length ? `<ul class="backups">${local.map(b => `
        <li><span>${when(b.at)}</span><small>${KIND[b.reason] || b.reason}・予定${b.events} todo${b.todos}</small>
          <button class="small" data-act="restore-local" data-id="${b.at}">この時点に戻す</button></li>`).join('')}</ul>`
        : '<p class="muted small">まだありません</p>'}
      <h4>ファイル</h4>
      <p class="muted small">月に1回ほど書き出して、iCloud Drive などに保存しておくと一番安心です。</p>
      <div class="actions"><button data-act="export">書き出し(JSON)</button><label class="btn">読み込み<input type="file" accept="application/json" id="importFile" hidden></label></div>
    </section>`;
}

// データを置き換える直前に、端末とサーバーの両方へ今の状態を残す
async function beforeReplace(reason) {
  Backup.snapshot(reason);
  if (Sync.currentUser()) await Sync.backupNow().catch(() => {});
}

function syncCard() {
  const st = Sync.status;
  const u = Sync.currentUser();
  const head = '<h3>同期（PC・iPhone）</h3>';
  if (st.state === 'off') return '';
  if (st.state === 'loading') return `<section class="card">${head}<p class="muted small">準備中…</p></section>`;
  if (!u) return `
    <section class="card">${head}
      <p class="muted small">PCとiPhoneで同じアカウントにログインすると、予定やtodoが自動で同じになります。初めての時は「新規登録」→ 届いた確認メールのリンクを押す → 「ログイン」の順です。</p>
      ${st.error ? `<p class="small danger">${esc(st.error)}</p>` : ''}
      <form id="authForm" class="form">
        <div class="row"><label>メール</label><input type="email" name="email" autocomplete="username" required></div>
        <div class="row"><label>パスワード</label><input type="password" name="pw" autocomplete="current-password" minlength="8" required placeholder="8文字以上"></div>
        <p class="small muted" id="authMsg"></p>
        <div class="actions"><button data-auth="signup">新規登録</button><span class="sp"></span><button class="primary" data-auth="signin">ログイン</button></div>
      </form>
    </section>`;
  const label = { syncing: '同期中…', ok: `同期済み${st.lastSync ? `（${hm(st.lastSync)}）` : ''}`,
    error: `同期できませんでした: ${esc(st.error)}`, offline: 'オフライン（つながったら自動で同期します）' }[st.state] || '';
  return `
    <section class="card">${head}
      <p class="small">ログイン中: <b>${esc(u.email)}</b></p>
      <p class="small ${st.state === 'error' ? 'danger' : 'muted'}">状態: ${label}</p>
      <div class="actions"><button data-act="sync-now">今すぐ同期</button><span class="sp"></span><button data-act="sign-out">ログアウト</button></div>
    </section>`;
}

/* ================= 通知・バッジ ================= */
// プッシュ通知で増えたバッジの数（Service Worker が数えている）はアプリを開いたら 0 に戻す
function clearPushBadge() {
  caches.open('todays-path-meta').then(c => c.put('badge', new Response('0'))).then(updateBadge).catch(() => {});
}

function updateBadge() {
  const n = (state.meta.badge || 0) + state.inbox.length + S.claudeAdded().length;
  if (!navigator.setAppBadge) return;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

async function notify(title, body, tag, url = './#path') {
  state.meta.badge = (state.meta.badge || 0) + 1;
  updateBadge();
  if ('Notification' in window && Notification.permission === 'granted') {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(title, { body, tag, data: { url }, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
    else new Notification(title, { body });
  } else toast(`${title}：${body}`);
}

// アプリを開いている間の通知。この端末がプッシュ通知を受け取る設定なら、サーバーから届くのでここでは出さない
function tick() {
  const now = new Date();
  const fired = state.meta.fired;
  let changed = false;
  for (const n of Push.planNotifications(U.addMinutes(now, -15), now)) {
    if (fired[n.key]) continue;
    fired[n.key] = now.getTime();
    changed = true;
    if (!Push.pushActive()) notify(n.title, n.body, n.tag, n.url);
  }

  const cutoff = now.getTime() - 10 * 86400000;
  for (const key in fired) if (fired[key] < cutoff) { delete fired[key]; changed = true; }
  if (changed) S.save();
}

/* ================= ルーティングと操作 ================= */
const VIEWS = { path: renderPath, cal: renderCal, todo: renderTodo, pay: renderPay, settings: renderSettings };

function render() {
  if (!VIEWS[view]) view = 'path';
  $$('.nav [data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  document.body.dataset.view = view;
  VIEWS[view]();
  if (S.saveError) toast('この端末に保存できませんでした（容量不足の可能性）。同期は続けています');
  $('#navBadge').textContent = (state.inbox.length + S.claudeAdded().length) || '';
  updateBadge();
}

function go(v) {
  if (v === view) return;
  view = v;
  history.replaceState(null, '', `#${v}`);
  $('#view').scrollTop = 0;
  render();
}

document.addEventListener('click', async e => {
  const nav = e.target.closest('.nav [data-view]');
  if (nav) return go(nav.dataset.view);
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const { act, id, day, v } = a.dataset;
  switch (act) {
    case 'done': {
      a.closest('li')?.classList.add('checking');
      setTimeout(() => S.completeTodo(id), 180);
      break;
    }
    case 'undone': S.uncompleteTodo(id); break;
    case 'edit-todo': openTodoForm(state.todos.find(t => t.id === id)); break;
    case 'edit-event': openEventForm(structuredClone(state.events.find(x => x.id === id)), { occDate: a.dataset.occ }); break;
    case 'add-event': openEventForm(null, { date: day }); break;
    case 'add-todo': openTodoForm(null); break;
    case 'add-todo-day': openTodoForm(null, { doDate: day }); break;
    case 'day': openDay(day); break;
    case 'approve': S.approveInbox(id); toast('追加しました'); break;
    case 'reject': S.rejectInbox(id); break;
    case 'seen': S.markSeen([id]); break;
    case 'seen-all': S.markSeen(); toast('すべて確認済みにしました'); break;
    case 'tag-color': pickColor(v); break;
    case 'tag-del': {
      const n = state.events.filter(x => x.tags?.includes(v)).length;
      const ok = await choose(`タグ「${esc(v)}」を削除しますか？${n ? `<br><small>付いている予定 ${n}件からも外します（予定は消えません）。</small>` : ''}`, [['y', '削除', 'danger']]);
      if (ok) S.deleteTag(v);
      break;
    }
    case 'check-ok': state.meta.checkDone = ymd(new Date()); S.save(); toast('今日の確認を記録しました'); break;
    case 'pt': {
      const base = pathTarget || startOfDay(new Date());
      pathTarget = v === 'today' ? startOfDay(new Date()) : v === 'tomorrow' ? addDays(startOfDay(new Date()), 1) : addDays(base, +v);
      renderPath();
      break;
    }
    case 'cal-today': calQuery = ''; $('#calSearch').value = ''; renderSearch(); scrollToDay(ymd(new Date())); break;
    case 'search-hit': scrollToDay(day); openEventForm(structuredClone(state.events.find(x => x.id === id)), { occDate: day }); break;
    case 'tab': todoTab = id; renderTodo(); break;
    case 'tabs-edit': openTabsEditor(); break;
    case 'clear-done': {
      const ok = await choose('完了済みのtodoを削除しますか？', [['y', '削除', 'danger']]);
      if (ok) { state.todos = state.todos.filter(t => !(t.done && (todoTab === 'all' || t.tabId === todoTab))); S.save(); }
      break;
    }
    case 'pay-m': payMonth = +v ? U.addMonths(payMonth, +v) : new Date(new Date().getFullYear(), new Date().getMonth(), 1); renderPay(); break;
    case 'sync-now': Sync.syncNow(); break;
    case 'sign-out': {
      const ok = await choose('ログアウトしますか？<br>この端末のデータはそのまま残ります。', [['y', 'ログアウト', 'danger']]);
      if (ok) await Sync.signOut();
      break;
    }
    case 'notif-perm': await Notification.requestPermission(); renderSettings(); break;
    case 'push-on': case 'push-off': {
      a.disabled = true;
      try {
        if (act === 'push-on') { await Push.enablePush(); toast('この端末で通知を受け取ります'); }
        else { await Push.disablePush(); toast('この端末では受け取りません'); }
      } catch (err) { toast(err.message || String(err)); }
      renderSettings();
      break;
    }
    case 'push-test': {
      a.disabled = true;
      try { await Push.sendTest(); toast('1〜2分以内に届きます。アプリを閉じて待ってください'); }
      catch (err) { toast(err.message || String(err)); a.disabled = false; }
      break;
    }
    case 'alarm-add': state.settings.alarms.push({ id: U.uid('al'), label: '', time: '08:00', days: [1, 2, 3, 4, 5], on: true }); S.save(); break;
    case 'alarm-del': state.settings.alarms = state.settings.alarms.filter(x => x.id !== id); S.save(); break;
    case 'backup-now': {
      a.disabled = true;
      try { await Sync.backupNow(); toast('バックアップしました'); } catch (err) { toast(`バックアップできませんでした: ${err.message}`); }
      await loadServerBackups();
      break;
    }
    case 'restore-server': case 'restore-local': {
      const ok = await choose('この時点のデータに戻しますか？<br><small>今のデータは戻す前にバックアップします。</small>', [['y', '戻す', 'danger']]);
      if (!ok) break;
      try {
        if (act === 'restore-local') {
          if (Sync.currentUser()) await Sync.backupNow().catch(() => {});
          Backup.restore(id);   // 端末側の「復元前」はこの中で保存される
        }
        else {
          const data = await Sync.loadBackup(+id);
          await beforeReplace('before-restore');
          S.replaceAll({ ...data, meta: { ...state.meta, checkDone: data.meta.checkDone } });
        }
        toast('戻しました');
        if (Sync.currentUser()) loadServerBackups();
      } catch (err) { toast(`戻せませんでした: ${err.message}`); }
      break;
    }
    case 'export': {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `todays-path-${ymd(new Date())}.json`;
      link.click();
      break;
    }
  }
});

// 「n」で追加などのキーボードショートカット（PC向け）
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select') || $('.modal') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'n') { e.preventDefault(); view === 'cal' ? openEventForm(null) : openTodoForm(null); }
  if (e.key === '/' && view === 'cal') { e.preventDefault(); $('#calSearch').focus(); }
  const keys = { 1: 'path', 2: 'cal', 3: 'todo', 4: 'pay', 5: 'settings' };
  if (keys[e.key]) go(keys[e.key]);
});

S.subscribe(render);
Sync.onStatus(() => {
  // 入力中のログインフォームは消さない
  if (view === 'settings' && !document.activeElement?.closest('#authForm')) renderSettings();
});
Sync.initSync();
Backup.initBackup();
Push.initPush().then(() => view === 'settings' && renderSettings());
window.addEventListener('hashchange', () => { readHash(); render(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { clearPushBadge(); tick(); if (view === 'path') renderPath(); } });
render();
clearPushBadge();
tick();
setInterval(tick, 30000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
