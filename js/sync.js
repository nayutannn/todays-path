// Supabase との同期。端末内のデータを正として表示し、変わった項目だけを送受信する。
// 1 件 = items テーブルの 1 行（kind + id）。削除は deleted=true で残し、他の端末にも消したことを伝える。
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { state, save, subscribe } from './store.js';

const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const SNAP_KEY = 'todays-path-sync';
const LIST = { event: 'events', todo: 'todos', tab: 'tabs', inbox: 'inbox' };

let sb = null, user = null, channel = null;
let busy = false, again = false, timer = null;
const listeners = new Set();
export const status = { state: 'loading', lastSync: null, error: '' };   // loading | signed-out | syncing | ok | error | offline
export const onStatus = f => listeners.add(f);
export const currentUser = () => user;
export const client = () => sb;
const setStatus = (s, extra = {}) => { Object.assign(status, { state: s, error: '' }, extra); listeners.forEach(f => f()); };

// 最後にサーバーと一致していた内容（kind:id → JSON）。ここと違う項目だけを送る
let snap = loadSnap();
function loadSnap() {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY)) || { items: {}, lastPull: null, userId: null }; }
  catch { return { items: {}, lastPull: null, userId: null }; }
}
const storeSnap = () => localStorage.setItem(SNAP_KEY, JSON.stringify(snap));

function localRecords() {
  const out = new Map();
  state.events.forEach(x => out.set(`event:${x.id}`, x));
  state.todos.forEach(x => out.set(`todo:${x.id}`, x));
  state.tabs.forEach((x, i) => out.set(`tab:${x.id}`, { ...x, pos: i }));
  state.inbox.forEach(x => out.set(`inbox:${x.id}`, x));
  out.set('settings:main', state.settings);
  out.set('settings:meta', { checkDone: state.meta.checkDone || '' });
  return out;
}
// サーバー（jsonb）はキーの順番を並べ替えて返すため、比較はキーを整列した JSON で行う
const canon = v => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const splitKey = key => { const i = key.indexOf(':'); return [key.slice(0, i), key.slice(i + 1)]; };

function setLocal(kind, id, data) {
  if (kind === 'settings') {
    if (id === 'main') Object.assign(state.settings, data);
    if (id === 'meta') state.meta.checkDone = data.checkDone || '';
    return;
  }
  const list = state[LIST[kind]];
  if (!list) return;
  const i = list.findIndex(x => x.id === id);
  if (i >= 0) list[i] = data; else list.push(data);
  if (kind === 'tab') list.sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
}
function removeLocal(kind, id) {
  const name = LIST[kind];
  if (!name) return;
  state[name] = state[name].filter(x => x.id !== id);
  if (kind === 'tab' && !state.tabs.length) state.tabs.push({ id: 'tab_main', name: '全般' });
}

// サーバーの行を端末に反映（前回知っていた内容から変わった行だけ）
function applyRemote(rows) {
  let changed = false;
  for (const r of rows) {
    const key = `${r.kind}:${r.id}`;
    if (r.deleted) {
      if (key in snap.items) { delete snap.items[key]; removeLocal(r.kind, r.id); changed = true; }
      continue;
    }
    const json = canon(r.data);
    if (snap.items[key] === json) continue;
    snap.items[key] = json;
    setLocal(r.kind, r.id, r.data);
    changed = true;
  }
  if (rows.length) {
    const latest = rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), snap.lastPull || '');
    snap.lastPull = latest || snap.lastPull;
  }
  storeSnap();
  if (changed) save();
}

async function push() {
  const local = localRecords();
  const now = new Date().toISOString();
  const rows = [];
  for (const [key, data] of local) {
    if (snap.items[key] === canon(data)) continue;
    const [kind, id] = splitKey(key);
    rows.push({ user_id: user.id, kind, id, data, deleted: false, updated_at: now });
  }
  for (const key in snap.items) {
    if (local.has(key)) continue;
    const [kind, id] = splitKey(key);
    rows.push({ user_id: user.id, kind, id, data: {}, deleted: true, updated_at: now });
  }
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await sb.from('items').upsert(chunk, { onConflict: 'user_id,kind,id' });
    if (error) throw error;
    for (const r of chunk) {
      const key = `${r.kind}:${r.id}`;
      if (r.deleted) delete snap.items[key]; else snap.items[key] = canon(r.data);
    }
    storeSnap();
  }
}

async function pull() {
  // 端末間の時計のずれを考えて 5 分ぶん重ねて取り直す（同じ内容は applyRemote で無視される）
  const since = snap.lastPull ? new Date(new Date(snap.lastPull) - 5 * 60000).toISOString() : null;
  for (let from = 0; ; from += 1000) {
    let q = sb.from('items').select('kind,id,data,deleted,updated_at').order('updated_at').range(from, from + 999);
    if (since) q = q.gt('updated_at', since);
    const { data, error } = await q;
    if (error) throw error;
    applyRemote(data);
    if (data.length < 1000) break;
  }
}

async function sync() {
  if (!user) return;
  if (busy) { again = true; return; }
  busy = true;
  setStatus('syncing', { lastSync: status.lastSync });
  try {
    // 初回はサーバーの内容を先に取り込んでから、端末にしかない項目を送る
    if (!snap.lastPull) { await pull(); await push(); }
    else { await push(); await pull(); }
    setStatus('ok', { lastSync: new Date() });
  } catch (e) {
    setStatus(navigator.onLine ? 'error' : 'offline', { lastSync: status.lastSync, error: e.message || String(e) });
  } finally {
    busy = false;
    if (again) { again = false; schedule(); }
  }
}
function schedule(ms = 1200) {
  clearTimeout(timer);
  timer = setTimeout(sync, ms);
}
export const syncNow = () => sync();

function startRealtime() {
  channel?.unsubscribe();
  channel = sb.channel('items-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, payload => {
      if (payload.new?.kind) applyRemote([payload.new]);
    })
    .subscribe();
}

function onSession(session) {
  const u = session?.user || null;
  if (u?.id === user?.id) { if (!u) setStatus('signed-out'); return; }
  user = u;
  if (!user) { channel?.unsubscribe(); channel = null; setStatus('signed-out'); return; }
  if (snap.userId !== user.id) { snap = { items: {}, lastPull: null, userId: user.id }; storeSnap(); }
  startRealtime();
  sync();
}

const MESSAGES = {
  'Invalid login credentials': 'メールアドレスかパスワードが違います',
  'Email not confirmed': '確認メールのリンクをまだ押していません。メールを確認してください',
  'User already registered': 'このメールアドレスは登録済みです。ログインしてください',
};
const friendly = e => {
  const m = e?.message || String(e);
  if (/Password should be at least/.test(m)) return 'パスワードは8文字以上にしてください';
  return MESSAGES[m] || m;
};

export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(friendly(error));
}
export async function signUp(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
  if (error) throw new Error(friendly(error));
  return { needsConfirm: !data.session };
}
export async function signOut() { await sb.auth.signOut(); }

export async function initSync() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return setStatus('off');
  try {
    const { createClient } = await import(LIB);
    sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'todays-path-auth' } });
  } catch {
    return setStatus('offline', { error: '同期の準備ができませんでした（オフライン？）' });
  }
  const { data } = await sb.auth.getSession();
  onSession(data.session);
  // コールバック内で他の Supabase 呼び出しを待つと固まるため、処理は次のタイミングに回す
  sb.auth.onAuthStateChange((_event, session) => setTimeout(() => onSession(session), 0));

  subscribe(() => { if (user) schedule(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && user) schedule(100); });
  window.addEventListener('online', () => user && schedule(100));
  setInterval(() => user && sync(), 60000);
}
