// データ保存とドメインロジック（予定の繰り返し展開・todoの繰り返し・Today's Path・給料計算）
import { parse, ymd, toLocal, startOfDay, addDays, addMonths, addMinutes, daysBetween, uid } from './util.js';

const KEY = 'todays-path-v1';

export const DEFAULT_SETTINGS = {
  morningTime: '06:30',      // 朝の Today's Path（今日分）
  eveningTime: '21:00',      // 夜の通知（明日の Today's Path）
  dailyCheck: true,          // 記入漏れチェック ON/OFF
  checkTime: '22:00',
  nearDueDays: 2,            // 「期限が迫っている」とみなす日数
  weekStart: 0,              // 0=日曜始まり 1=月曜始まり
  workTag: 'バイト',
  defaultWage: 1100,
  nightPremium: true,        // 22:00〜5:00 の深夜割増 25%
  todoSort: 'manual',
  alarms: [],                // 自由に設定する通知 {id,label,time,days:[0-6],on}
};

const listeners = new Set();
export const state = load();

function fresh() {
  return {
    version: 1,
    tabs: [{ id: 'tab_main', name: '全般' }],
    todos: [], events: [], inbox: [],
    settings: { ...DEFAULT_SETTINGS },
    meta: { fired: {}, checkDone: '', badge: 0 },
  };
}
function migrate(s) {
  const f = fresh();
  for (const k of ['tabs', 'todos', 'events', 'inbox']) s[k] ??= f[k];
  if (!s.tabs.length) s.tabs = f.tabs;
  s.settings = { ...DEFAULT_SETTINGS, ...s.settings };
  s.meta = { ...f.meta, ...s.meta };
  return s;
}
function load() {
  const raw = localStorage.getItem(KEY);
  try { const s = JSON.parse(raw); if (s) return migrate(s); }
  catch {
    // 読めないデータでも上書きで消さないよう、別の場所に残してから初期化する
    try { localStorage.setItem(`${KEY}-broken-${Date.now()}`, raw); } catch { /* 容量不足なら諦める */ }
  }
  return fresh();
}
export let saveError = null;   // 端末への保存に失敗したとき（容量不足など）の内容。画面で知らせる
export function save() {
  state.meta.updatedAt = new Date().toISOString();
  try { localStorage.setItem(KEY, JSON.stringify(state)); saveError = null; }
  catch (e) { saveError = e; }
  listeners.forEach(f => f());
}
export const subscribe = f => { listeners.add(f); return () => listeners.delete(f); };
export function replaceAll(obj) {
  const next = migrate(obj);   // 読み込めないデータなら、今のデータを消す前にここで失敗させる
  Object.keys(state).forEach(k => delete state[k]);
  Object.assign(state, next);
  save();
}

/* ---------- 繰り返し ---------- */
export const FREQ_LABEL = { none: 'なし', day: '日', week: '週', month: 'か月', year: '年' };
// 基準日から k 回目（月末のずれが積み重ならないよう常に基準から計算）
export function stepFrom(base, rep, k) {
  const n = (rep.interval || 1) * k;
  switch (rep.freq) {
    case 'day': return addDays(base, n);
    case 'week': return addDays(base, 7 * n);
    case 'month': return addMonths(base, n);
    case 'year': return addMonths(base, 12 * n);
  }
  return null;
}
const isRepeating = r => r && r.freq && r.freq !== 'none';

/* ---------- 予定 ---------- */
function span(ev) {
  const s = parse(ev.start);
  let e = parse(ev.end) || s;
  if (ev.allDay) e = addDays(startOfDay(e), 1);
  if (e <= s) e = ev.allDay ? addDays(s, 1) : s;
  return [s, e];
}

// [from, to) と重なる発生回を返す
export function occurrences(ev, from, to) {
  const [s, e] = span(ev);
  const dur = e - s;
  const out = [];
  if (!isRepeating(ev.repeat)) {
    if (s < to && (e > from || (dur === 0 && s >= from))) out.push({ ev, start: s, end: e, key: `${ev.id}@${ymd(s)}` });
    return out;
  }
  const rep = ev.repeat;
  const until = rep.until ? addDays(parse(rep.until), 1) : null;
  const ex = new Set(ev.exdates || []);
  let k = 0;
  if (rep.freq === 'day' || rep.freq === 'week') {
    const period = (rep.freq === 'day' ? 1 : 7) * (rep.interval || 1) * 86400000;
    k = Math.max(0, Math.floor((from - s - dur) / period) - 1);
  }
  for (let guard = 0; guard < 3000; guard++, k++) {
    const os = stepFrom(s, rep, k);
    if (os >= to || (until && os >= until)) break;
    const oe = new Date(os.getTime() + dur);
    if ((oe > from || (dur === 0 && os >= from)) && !ex.has(ymd(os))) out.push({ ev, start: os, end: oe, key: `${ev.id}@${ymd(os)}` });
  }
  return out;
}

export function occurrencesIn(from, to) {
  return state.events.flatMap(ev => occurrences(ev, from, to))
    .sort((a, b) => (b.ev.allDay - a.ev.allDay) || (a.start - b.start));
}

// 日付 → その日に掛かる発生回 の Map（カレンダー描画用）
export function dayMap(from, to) {
  const map = new Map();
  for (const o of occurrencesIn(from, to)) {
    let d = startOfDay(o.start < from ? from : o.start);
    const last = o.end > o.start ? new Date(o.end - 1) : o.start;
    while (d <= last && d < to) {
      const k = ymd(d);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(o);
      d = addDays(d, 1);
    }
  }
  return map;
}

// 時間指定の予定どうしの重なり（ダブルブッキング）
const overlaps = (a, b) => !a.ev.allDay && !b.ev.allDay && a.start < b.end && b.start < a.end;
export function findConflicts(draft, ignoreId) {
  if (draft.allDay) return [];
  const [s] = span(draft);
  const to = addDays(s, isRepeating(draft.repeat) ? 90 : 1);
  const mine = occurrences({ ...draft, id: '__draft' }, startOfDay(s), to);
  const others = state.events.filter(e => e.id !== ignoreId).flatMap(e => occurrences(e, startOfDay(s), to));
  const hits = [];
  for (const m of mine) for (const o of others) if (overlaps(m, o)) hits.push(o);
  return hits;
}
export function conflictKeys(occs) {
  const set = new Set();
  for (let i = 0; i < occs.length; i++)
    for (let j = i + 1; j < occs.length; j++)
      if (overlaps(occs[i], occs[j])) { set.add(occs[i].key); set.add(occs[j].key); }
  return set;
}

export function upsertEvent(ev) {
  ev.updatedAt = new Date().toISOString();
  const i = state.events.findIndex(e => e.id === ev.id);
  if (i >= 0) state.events[i] = ev;
  else state.events.push({ createdAt: ev.updatedAt, source: 'manual', ...ev, id: ev.id || uid('ev') });
  save();
}
export function deleteEvent(id, onlyDate) {
  const ev = state.events.find(e => e.id === id);
  if (!ev) return;
  if (onlyDate && isRepeating(ev.repeat)) (ev.exdates ||= []).push(onlyDate);
  else state.events = state.events.filter(e => e.id !== id);
  save();
}
// 繰り返し予定を date（YYYY-MM-DD）の回から先だけ消す。最初の回からなら全部消す
export function deleteEventFrom(id, date) {
  const ev = state.events.find(e => e.id === id);
  if (!ev) return;
  if (!isRepeating(ev.repeat) || date <= ev.start.slice(0, 10)) return deleteEvent(id);
  ev.repeat = { ...ev.repeat, until: ymd(addDays(parse(date), -1)) };
  ev.exdates = (ev.exdates || []).filter(d => d < date);
  ev.updatedAt = new Date().toISOString();
  save();
}

export const isWork = ev => (ev.tags || []).includes(state.settings.workTag);

/* ---------- todo ---------- */
// 繰り返しtodoは完了/削除しても hiddenUntil（元の期限）を過ぎるとリストに戻る
export const isVisible = (t, now = new Date()) => !t.hiddenUntil || parse(t.hiddenUntil) <= now;
export const activeTodos = (now = new Date()) => state.todos.filter(t => !t.done && isVisible(t, now));

export function upsertTodo(t) {
  t.updatedAt = new Date().toISOString();
  const i = state.todos.findIndex(x => x.id === t.id);
  if (i >= 0) state.todos[i] = t;
  else state.todos.push({
    createdAt: t.updatedAt, source: 'manual', priority: 0, done: false,
    order: Math.max(0, ...state.todos.map(x => x.order ?? 0)) + 1, ...t, id: t.id || uid('td'),
  });
  save();
}

function advanceRepeat(t) {
  const old = parse(t.due);
  const now = new Date();
  let k = 1, next = stepFrom(old, t.repeat, 1);
  while (next <= now && k < 1000) next = stepFrom(old, t.repeat, ++k);
  t.hiddenUntil = t.due;
  t.due = toLocal(next);
  if (t.doDate) t.doDate = ymd(stepFrom(parse(t.doDate), t.repeat, k));
}
export function completeTodo(id) {
  const t = state.todos.find(x => x.id === id);
  if (!t) return;
  if (isRepeating(t.repeat) && t.due) advanceRepeat(t);
  else { t.done = true; t.doneAt = new Date().toISOString(); }
  save();
}
export function uncompleteTodo(id) {
  const t = state.todos.find(x => x.id === id);
  if (t) { t.done = false; delete t.doneAt; save(); }
}
// skipOnly: 繰り返しtodoを今回分だけ消す（期限が過ぎると次回分として復活）
export function deleteTodo(id, skipOnly) {
  const t = state.todos.find(x => x.id === id);
  if (!t) return;
  if (skipOnly && isRepeating(t.repeat) && t.due) advanceRepeat(t);
  else state.todos = state.todos.filter(x => x.id !== id);
  save();
}

/* ---------- 給料 ---------- */
export function shiftPay(o) {
  const s = state.settings;
  const wage = Number(o.ev.wage) || s.defaultWage;
  const breakMin = Number(o.ev.breakMin) || 0;
  const totalMin = Math.max(0, (o.end - o.start) / 60000);
  let night = 0;
  if (s.nightPremium) {
    for (let t = new Date(o.start); t < o.end; t = addMinutes(t, 5)) {
      const h = t.getHours();
      if (h >= 22 || h < 5) night += 5;
    }
  }
  const workMin = Math.max(0, totalMin - breakMin);
  night = Math.min(night, workMin);
  const pay = wage * workMin / 60 + wage * 0.25 * night / 60;
  return { wage, workMin, nightMin: night, pay };
}
export function payInRange(from, to) {
  const shifts = occurrencesIn(from, to).filter(o => isWork(o.ev)).map(o => ({ ...o, ...shiftPay(o) }));
  return {
    shifts,
    minutes: shifts.reduce((a, x) => a + x.workMin, 0),
    pay: shifts.reduce((a, x) => a + x.pay, 0),
  };
}

/* ---------- Today's Path ---------- */
const keywords = s => (s || '').split(/[,、，\s]+/).map(x => x.trim()).filter(Boolean);

export function buildPath(target, now = new Date()) {
  const day = startOfDay(target);
  const next = addDays(day, 1);
  const dayKey = ymd(day);
  const s = state.settings;

  const events = occurrencesIn(day, next);
  const conflicts = conflictKeys(events);
  const todos = activeTodos(now);
  const used = new Set();
  const take = list => { list.forEach(t => used.add(t.id)); return list; };

  const dueLimit = addDays(day, 1 + Number(s.nearDueDays));
  const dueSoon = take(todos.filter(t => t.due && parse(t.due) < dueLimit)
    .sort((a, b) => parse(a.due) - parse(b.due)));

  const doToday = take(todos.filter(t => !used.has(t.id) && t.doDate && t.doDate <= dayKey)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0)));

  // 予定のタイトル・場所と todo の「ついでキーワード」が一致したら提案
  const alongside = [];
  for (const t of todos) {
    if (used.has(t.id)) continue;
    const kws = keywords(t.context);
    if (!kws.length) continue;
    const o = events.find(o => kws.some(k => `${o.ev.title} ${o.ev.location || ''}`.includes(k)));
    if (o) { alongside.push({ todo: t, occ: o }); used.add(t.id); }
  }

  const longTerm = todos.filter(t => {
    if (used.has(t.id) || !t.longLead) return false;
    const d = parse(t.due) || parse(t.doDate);
    if (!d) return false;
    const left = daysBetween(day, d);
    return left >= 0 && left <= Number(t.longLead);
  }).map(t => ({ todo: t, left: daysBetween(day, parse(t.due) || parse(t.doDate)) }))
    .sort((a, b) => a.left - b.left);

  const work = events.filter(o => isWork(o.ev)).map(o => ({ ...o, ...shiftPay(o) }));
  return { day, events, conflicts, dueSoon, doToday, alongside, longTerm, work };
}

/* ---------- 確認待ち（Claudeが判断に迷った候補） ---------- */
export function approveInbox(id) {
  const item = state.inbox.find(x => x.id === id);
  if (!item) return;
  if (item.kind === 'event') upsertEvent({ ...item.data, source: item.source || 'claude' });
  else upsertTodo({ tabId: state.tabs[0].id, ...item.data, source: item.source || 'claude' });
  state.inbox = state.inbox.filter(x => x.id !== id);
  save();
}
export function rejectInbox(id) {
  state.inbox = state.inbox.filter(x => x.id !== id);
  save();
}
