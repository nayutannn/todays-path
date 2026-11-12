// Claude の調査メモ（読むだけ）。サーバーの notes 表（supabase/notes.sql）から取る。
// 一覧（題名・要約・キーワード・紐づけ）は端末に保存してオフラインでも出す。本文は開いたときに取り、少しだけ端末に残す。
import * as Sync from './sync.js';

const META_KEY = 'todays-path-notes';
const BODY_KEY = 'todays-path-notes-body';
const BODY_LIMIT = 800_000;   // 本文の端末保存は合計この文字数まで（古いものから捨てる）

let list = load(META_KEY, []);   // [{ id, title, status, keywords, links:[{kind,id}], summary, created, updated }]
let bodies = load(BODY_KEY, {}); // id → { u: updated, b: 本文, t: 最後に開いた時刻 }
let loading = null, lastLoad = 0;
export let error = '';
const listeners = new Set();
export const onChange = f => listeners.add(f);
const emit = () => listeners.forEach(f => f());

function load(key, def) { try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; } }
function store(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

export const all = () => list;
export const get = id => list.find(n => n.id === id);
export const forItem = id => list.filter(n => (n.links || []).some(l => l.id === id));

// サーバーから一覧を取り直す（短い間に何度も呼ばれても 1 回にまとめる）
export function refresh(force = false) {
  const sb = Sync.client();
  if (!sb || !Sync.currentUser()) return Promise.resolve();
  if (loading) return loading;
  if (!force && Date.now() - lastLoad < 60_000) return Promise.resolve();
  loading = (async () => {
    const { data, error: e } = await sb.from('notes').select('id, meta, updated_at').order('updated_at', { ascending: false });
    if (e) { error = /notes/.test(e.message) && /exist|find/.test(e.message) ? 'サーバーの準備がまだです（supabase/notes.sql）' : e.message; return; }
    error = '';
    const next = data.map(r => ({ id: r.id, ...r.meta, at: r.updated_at }));
    const changed = JSON.stringify(next) !== JSON.stringify(list);
    list = next;
    lastLoad = Date.now();
    // 消えたメモの本文は捨てる
    for (const id in bodies) if (!list.some(n => n.id === id)) delete bodies[id];
    store(META_KEY, list); store(BODY_KEY, bodies);
    if (changed) emit();
  })().catch(e => { error = e.message || String(e); }).finally(() => { loading = null; });
  return loading;
}

export async function body(id) {
  const n = get(id);
  const c = bodies[id];
  if (c && n && c.u === n.at) { c.t = Date.now(); return c.b; }
  const sb = Sync.client();
  if (!sb || !Sync.currentUser()) { if (c) return c.b; throw new Error('ログインすると読めます'); }
  const { data, error: e } = await sb.from('notes').select('body, updated_at').eq('id', id).single();
  if (e) { if (c) return c.b; throw e; }
  bodies[id] = { u: data.updated_at, b: data.body, t: Date.now() };
  // 端末に残す量を抑える
  let size = Object.values(bodies).reduce((a, x) => a + x.b.length, 0);
  for (const [k] of Object.entries(bodies).sort((a, b) => a[1].t - b[1].t)) {
    if (size <= BODY_LIMIT || k === id) continue;
    size -= bodies[k].b.length; delete bodies[k];
  }
  store(BODY_KEY, bodies);
  return data.body;
}

/* ---------- Markdown を HTML に（メモ用の小さな変換。HTML はすべてエスケープしてから組み立てる） ---------- */
const escH = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = escH(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escH(codes[i])}</code>`);
}
export function md(src) {
  const lines = src.replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      out.push(`<pre><code>${escH(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) { out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); i++; continue; }
    if (/^\s*\|/.test(l)) {
      const rows = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
      const head = rows.shift();
      const body = rows.filter(r => !r.every(c => /^:?-+:?$/.test(c)));
      out.push(`<div class="tblwrap"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
        body.map(r => `<tr>${r.map(c => `<td>${inline(c).replace(/&lt;br&gt;/g, '<br>')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) {
        const deep = /^\s{2,}/.test(lines[i]);
        if (!deep && /^\s*\d+\./.test(lines[i]) !== ordered) break;   // 箇条書きと番号付きが切り替わったら別のリスト
        items.push(`<li${deep ? ' class="deep"' : ''}>${inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`);
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^>\s?/.test(l)) {
      const buf = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) buf.push(lines[i].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }
    if (/^---+\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const buf = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*\||\s*([-*]|\d+\.)\s|>|---+\s*$)/.test(lines[i]); i++) buf.push(lines[i]);
    out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}
