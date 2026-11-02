// 日付は端末ローカル時刻の文字列で保持する: 日付 "YYYY-MM-DD" / 日時 "YYYY-MM-DDTHH:MM"
export const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const toLocal = d => `${ymd(d)}T${hm(d)}`;

export function parse(s) {
  if (!s) return null;
  const [date, time = '00:00'] = s.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi);
}

export const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMinutes = (d, n) => new Date(d.getTime() + n * 60000);
export function addMonths(d, n) {
  const x = new Date(d);
  const day = x.getDate();
  x.setDate(1);
  x.setMonth(x.getMonth() + n);
  const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
  x.setDate(Math.min(day, last));
  return x;
}
export const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);

export const WD = ['日', '月', '火', '水', '木', '金', '土'];
export const fmtDate = d => `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
export const fmtDateTime = d => `${fmtDate(d)} ${hm(d)}`;

// 期限の相対表示（Today's Path やリストで一目で分かるように短く）
export function relDue(due, now = new Date()) {
  const diff = daysBetween(now, due);
  if (due < now) return { text: diff === 0 ? `今日 ${hm(due)} 超過` : `${-diff}日超過`, level: 'over' };
  if (diff === 0) return { text: `今日 ${hm(due)}`, level: 'today' };
  if (diff === 1) return { text: `明日 ${hm(due)}`, level: 'soon' };
  if (diff < 7) return { text: `${fmtDate(due)} ${hm(due)}`, level: 'wk' };
  return { text: fmtDate(due), level: 'later' };
}

export const uid = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const yen = n => `¥${Math.round(n).toLocaleString('ja-JP')}`;

// 5分刻みの時刻リスト
export const TIMES = Array.from({ length: 288 }, (_, i) => `${pad(Math.floor(i / 12))}:${pad((i % 12) * 5)}`);
export const roundTo5 = d => { const x = new Date(d); x.setMinutes(Math.ceil(x.getMinutes() / 5) * 5, 0, 0); return x; };
