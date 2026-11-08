// Claude がアプリのデータを読み書きするための窓口（window.TP）。
// ログイン済みのアプリ上で呼ぶので、保存・同期・通知の予定表づくりは手入力と同じ流れで行われる。
import * as U from './util.js';
import * as S from './store.js';
import * as Sync from './sync.js';

const { state } = S;
const { parse, addDays, startOfDay, ymd } = U;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const NONE = { freq: 'none', interval: 1, until: '' };

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
const occView = o => ({ id: o.ev.id, date: ymd(o.start), title: o.ev.title, allDay: !!o.ev.allDay,
  start: o.ev.allDay ? ymd(o.start) : U.toLocal(o.start), end: o.ev.allDay ? ymd(o.end) : U.toLocal(o.end),
  location: o.ev.location || '', tags: o.ev.tags || [], source: o.ev.source, memo: o.ev.memo || '' });
const todoView = t => ({ id: t.id, title: t.title, tab: state.tabs.find(x => x.id === t.tabId)?.name, due: t.due || '',
  doDate: t.doDate || '', priority: t.priority || 0, done: !!t.done, memo: t.memo || '', source: t.source });
const norm = s => String(s || '').replace(/[\s　・\-ー（）()「」【】]/g, '').toLowerCase();

function tabIdOf(name) {
  if (!name) return state.tabs[0].id;
  const tab = state.tabs.find(x => x.name === name || x.id === name);
  if (tab) return tab.id;
  const id = U.uid('tab');
  state.tabs.push({ id, name });
  return id;
}

function eventDraft(x) {
  const allDay = !!x.allDay || DATE.test(x.start || '');
  const ev = {
    title: String(x.title || '').trim(), allDay, start: x.start, end: x.end || x.start,
    location: x.location || '', memo: x.memo || '', tags: x.tags || [],
    repeat: { ...NONE, ...x.repeat }, reminders: x.reminders ?? (allDay ? [] : [10]),
  };
  if (S.isWork(ev)) { ev.wage = x.wage ?? state.settings.defaultWage; ev.breakMin = x.breakMin ?? 0; }
  if (!ev.title) return [null, 'title がありません'];
  if (!(allDay ? DATE : DATETIME).test(ev.start) || !(allDay ? DATE : DATETIME).test(ev.end))
    return [null, allDay ? '終日の予定は start/end を YYYY-MM-DD で指定してください' : 'start/end は YYYY-MM-DDTHH:MM で指定してください'];
  if (parse(ev.end) < parse(ev.start)) return [null, '終了が開始より前です'];
  return [ev, null];
}

function todoDraft(x) {
  const t = {
    title: String(x.title || '').trim(), tabId: tabIdOf(x.tab), due: x.due || '', doDate: x.doDate || '',
    priority: Math.min(3, Math.max(0, +x.priority || 0)), repeat: x.due && x.repeat ? { freq: 'none', interval: 1, ...x.repeat } : { freq: 'none', interval: 1 },
    longLead: +x.longLead || 0, context: x.context || '', memo: x.memo || '', reminders: x.reminders || [],
  };
  if (!t.title) return [null, 'title がありません'];
  if (t.due && !DATETIME.test(t.due)) return [null, 'due は YYYY-MM-DDTHH:MM で指定してください'];
  if (t.doDate && !DATE.test(t.doDate)) return [null, 'doDate は YYYY-MM-DD で指定してください'];
  return [t, null];
}

// 同じ日の似た名前の予定（同じ写真を二度送られたときの重複防止）
function sameEvents(ev) {
  const day = startOfDay(parse(ev.start));
  return S.occurrencesIn(day, addDays(day, 1)).filter(o => {
    const a = norm(o.ev.title), b = norm(ev.title);
    return a && b && (a.includes(b) || b.includes(a));
  }).map(occView);
}
const sameTodos = t => state.todos.filter(x => !x.done && norm(x.title) === norm(t.title)).map(todoView);

window.TP = {
  status: () => ({
    user: Sync.currentUser()?.email || null, sync: Sync.status.state,
    events: state.events.length, todos: state.todos.length, inbox: state.inbox.length,
    tabs: state.tabs.map(x => x.name), workTag: state.settings.workTag, defaultWage: state.settings.defaultWage,
    tags: S.tagList().map(t => t.name), unseen: S.claudeAdded().length,
  }),
  // ユーザーが作ったタグ（予定を追加するときは、この中から合うものを付ける）
  tags: () => [...S.tagList().map(t => ({ ...t })), ...S.unregisteredTags().map(name => ({ name, color: null }))],
  // from / to は YYYY-MM-DD（to はその日を含む）
  events: (from, to = from) => S.occurrencesIn(parse(from), addDays(parse(to), 1)).map(occView),
  todos: ({ done = false } = {}) => state.todos.filter(t => done || !t.done).map(todoView),
  inbox: () => state.inbox.map(x => ({ id: x.id, kind: x.kind, title: x.data.title, reason: x.reason })),
  search: q => {
    const n = norm(q);
    return {
      events: state.events.filter(e => norm(e.title).includes(n) || norm(e.location).includes(n))
        .map(e => ({ id: e.id, title: e.title, start: e.start, location: e.location || '' })),
      todos: state.todos.filter(t => norm(t.title).includes(n)).map(todoView),
    };
  },

  // 重なり・重複があれば保存せずに返す。確認のうえで保存するときは { force: true }
  // source: 情報元（例「iCloudメール: 件名」）、sourceNote: 送信者・日時・該当箇所など（アプリに表示される）
  addEvent(x, { force = false, source = 'claude', sourceNote = '' } = {}) {
    const [ev, err] = eventDraft(x);
    if (err) return fail(err);
    const duplicates = sameEvents(ev);
    const conflicts = S.findConflicts(ev).map(occView);
    if (!force && (duplicates.length || conflicts.length)) return fail('確認が必要です', { duplicates, conflicts });
    const id = U.uid('ev');
    S.registerTags(ev.tags);
    S.upsertEvent({ ...ev, id, source, ...(sourceNote ? { sourceNote } : {}), claudeNew: true });
    return { ok: true, id, conflicts };
  },
  addTodo(x, { force = false, source = 'claude', sourceNote = '' } = {}) {
    const [t, err] = todoDraft(x);
    if (err) return fail(err);
    const duplicates = sameTodos(t);
    if (!force && duplicates.length) return fail('確認が必要です', { duplicates });
    const id = U.uid('td');
    S.upsertTodo({ ...t, id, source, ...(sourceNote ? { sourceNote } : {}), claudeNew: true });
    return { ok: true, id };
  },
  // 判断に迷う候補はアプリの「確認待ち」へ。reason に迷った理由を書く。
  // 既にある予定・todo と大きく違うときは replaces にその id を入れる（「追加」でその項目が書き換わる）
  ask(kind, x, reason, { source = 'claude', sourceNote = '', replaces = null } = {}) {
    if (kind !== 'event' && kind !== 'todo') return fail('kind は event か todo です');
    const [data, err] = kind === 'event' ? eventDraft(x) : todoDraft(x);
    if (err) return fail(err);
    if (replaces && !(kind === 'event' ? state.events : state.todos).some(e => e.id === replaces)) return fail('replaces の id が見つかりません');
    const id = U.uid('ib');
    state.inbox.push({ id, kind, data, reason: reason || '', source, ...(sourceNote ? { sourceNote } : {}), replaces, createdAt: new Date().toISOString() });
    S.save();
    return { ok: true, id };
  },
  // Claude が自分で追加した予定・todo だけを消せる（ユーザーが入れたものは消さない）
  removeOwn(id) {
    const ev = state.events.find(e => e.id === id), t = state.todos.find(x => x.id === id);
    const it = ev || t;
    if (!it) return fail('見つかりません');
    if (!it.source || it.source === 'manual') return fail('ユーザーが入れた項目は消せません');
    ev ? S.deleteEvent(id) : S.deleteTodo(id);
    return { ok: true };
  },
  // 確認待ちの判断（ユーザーがチャットで答えたときに使う）
  approve: id => { S.approveInbox(id); return { ok: true }; },
  reject: id => { S.rejectInbox(id); return { ok: true }; },
  sync: async () => { await Sync.syncNow(); return Sync.status.state; },
};
