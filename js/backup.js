// 端末内のバックアップ。1 日 1 回と、読み込み・復元でデータを置き換える直前に、今のデータを丸ごと残す。
// サーバー側のバックアップ（毎日自動）とは別に持つので、同期の不具合で消えた場合もこの端末から戻せる。
import * as S from './store.js';

const KEY = 'todays-path-backups';
const KEEP_DAILY = 7, KEEP_OTHER = 5;

export function list() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}
function write(items) {
  // 容量が足りなければ古いものから減らして入れ直す
  while (items.length) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); return true; }
    catch { items.pop(); }
  }
  return false;
}
const strip = st => { const { meta, ...rest } = structuredClone(st); return { ...rest, meta: { checkDone: meta.checkDone || '' } }; };
const count = st => st.events.length + st.todos.length;

// reason: daily | before-import | before-restore など
export function snapshot(reason) {
  const st = S.state;
  if (!count(st)) return false;           // 空のデータで良いバックアップを押し出さない
  const items = list();
  const today = new Date().toLocaleDateString('sv');
  if (reason === 'daily' && items.some(x => x.reason === 'daily' && x.day === today)) return false;
  items.unshift({ at: new Date().toISOString(), day: today, reason, events: st.events.length, todos: st.todos.length, data: strip(st) });
  const daily = items.filter(x => x.reason === 'daily').slice(0, KEEP_DAILY);
  const other = items.filter(x => x.reason !== 'daily').slice(0, KEEP_OTHER);
  return write([...daily, ...other].sort((a, b) => b.at.localeCompare(a.at)));
}

export function restore(at) {
  const item = list().find(x => x.at === at);
  if (!item) return false;
  snapshot('before-restore');
  S.replaceAll({ ...item.data, meta: { ...S.state.meta, checkDone: item.data.meta?.checkDone || '' } });
  return true;
}

export function initBackup() {
  // ブラウザが容量不足のときに勝手にデータを消さないよう頼んでおく
  navigator.storage?.persist?.().catch(() => {});
  snapshot('daily');
  setInterval(() => snapshot('daily'), 3600000);
}
