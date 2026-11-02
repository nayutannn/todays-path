// 通知の予定表づくりと、アプリを閉じていても届くプッシュ通知の登録。
// 端末で「いつ・何を通知するか」を先に計算して Supabase に置き、サーバー（Edge Function）が時刻になったら送る。
import * as U from './util.js';
import * as S from './store.js';
import * as Sync from './sync.js';
import { VAPID_PUBLIC_KEY } from './config.js';

const { state } = S;
const { ymd, parse, addDays, startOfDay } = U;
const HORIZON_DAYS = 14;
const SENT_KEY = 'todays-path-push';

export function pathSummary(target, now = new Date()) {
  const p = S.buildPath(target, now);
  const parts = [];
  if (p.events.length) parts.push(`予定${p.events.length}件（${p.events.slice(0, 2).map(o => o.ev.title).join('、')}${p.events.length > 2 ? '…' : ''}）`);
  if (p.dueSoon.length) parts.push(`期限間近${p.dueSoon.length}件`);
  if (p.doToday.length) parts.push(`やる日${p.doToday.length}件`);
  if (p.longTerm.length) parts.push(`長期${p.longTerm.length}件`);
  return parts.join(' / ') || '予定もtodoもありません';
}

// from〜to に鳴る通知の一覧（key は同じ通知を二重に出さないための目印）
export function planNotifications(from, to) {
  const out = [];
  const add = (key, at, title, body, tag, url = './#path') => { if (at >= from && at < to) out.push({ key, at, title, body, tag, url }); };
  const s = state.settings;

  for (const o of S.occurrencesIn(addDays(from, -1), addDays(to, 8)))
    for (const m of o.ev.reminders || [])
      add(`ev:${o.key}:${m}`, U.addMinutes(o.start, -m), o.ev.title,
        `${o.ev.allDay ? U.fmtDate(o.start) : U.fmtDateTime(o.start)}${o.ev.location ? ` @${o.ev.location}` : ''}`, o.key);
  for (const t of S.activeTodos(from))
    if (t.due) for (const m of t.reminders || [])
      add(`td:${t.id}:${t.due}:${m}`, U.addMinutes(parse(t.due), -m), `期限: ${t.title}`, U.fmtDateTime(parse(t.due)), t.id);

  for (let day = startOfDay(from); day < to; day = addDays(day, 1)) {
    const k = ymd(day);
    const at = time => { const [h, m] = time.split(':').map(Number); return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m); };
    const morning = at(s.morningTime), evening = at(s.eveningTime);
    add(`path:m:${k}`, morning, "今日の Today's Path", pathSummary(day, morning), 'path');
    add(`path:e:${k}`, evening, "明日の Today's Path", pathSummary(addDays(day, 1), evening), 'path', './#path-tomorrow');
    if (s.dailyCheck && state.meta.checkDone !== k)
      add(`check:${k}`, at(s.checkTime), '記入漏れチェック', '今日の予定・todoに書き忘れはありませんか？', 'check');
    for (const a of s.alarms)
      if (a.on && a.days.includes(day.getDay())) add(`al:${a.id}:${k}:${a.time}`, at(a.time), a.label || '通知', a.time, a.id);
  }
  return out.sort((a, b) => a.at - b.at);
}

/* ---------- この端末のプッシュ通知の登録 ---------- */
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const b64ToBytes = s => Uint8Array.from(atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const deviceName = () => /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'PC';

let active = false;         // この端末がプッシュ通知を受け取る設定になっているか
export const pushActive = () => active;

async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function saveSub(sub) {
  const sb = Sync.client(), user = Sync.currentUser();
  if (!sb || !user) throw new Error('先に同期のログインをしてください');
  const { error } = await sb.from('push_subscriptions').upsert({ endpoint: sub.endpoint, user_id: user.id, sub: sub.toJSON(), device: deviceName() });
  if (error) throw error;
}

export async function enablePush() {
  if (!pushSupported()) throw new Error('この環境ではプッシュ通知を使えません（iPhoneはホーム画面に追加したアプリから設定してください）');
  if (!Sync.currentUser()) throw new Error('先に同期のログインをしてください');
  if (await Notification.requestPermission() !== 'granted') throw new Error('通知が許可されませんでした');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription()
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) });
  await saveSub(sub);
  active = true;
  await uploadSchedule(true);
}

export async function disablePush() {
  const sub = await currentSub();
  if (sub) {
    await Sync.client()?.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe();
  }
  active = false;
}

/* ---------- 通知予定表をサーバーへ ---------- */
let timer = null;
let testItem = null;        // 「テスト通知」で一時的に足す 1 件
export async function uploadSchedule(force = false) {
  const sb = Sync.client(), user = Sync.currentUser();
  if (!sb || !user) return;
  const now = new Date();
  const plan = planNotifications(U.addMinutes(now, -1), addDays(now, HORIZON_DAYS));
  if (testItem && testItem.at > U.addMinutes(now, -5)) plan.unshift(testItem); else testItem = null;
  const items = plan.map(({ key, at, title, body, tag, url }) => ({ key, at: at.toISOString(), title, body, tag, url }));
  // 内容が同じなら送らない（ただし 1 時間に 1 回は先の日付まで延ばすために送り直す）
  const json = JSON.stringify(items.map(({ at, ...x }) => ({ ...x, at: at.slice(0, 16) })));
  let last = {};
  try { last = JSON.parse(localStorage.getItem(SENT_KEY)) || {}; } catch {}
  if (!force && last.user === user.id && last.json === json && now - (last.time || 0) < 3600000) return;
  const { error } = await sb.from('push_schedule').upsert({ user_id: user.id, items, updated_at: now.toISOString() });
  if (error) throw error;
  localStorage.setItem(SENT_KEY, JSON.stringify({ user: user.id, json, time: now.getTime() }));
}
export async function sendTest() {
  if (!Sync.currentUser()) throw new Error('先に同期のログインをしてください');
  const at = U.addMinutes(new Date(), 1);
  testItem = { key: `test:${at.getTime()}`, at, title: 'テスト通知', body: 'アプリを閉じていても通知が届きます', tag: 'test', url: './#settings' };
  await uploadSchedule(true);
}
const scheduleUpload = (ms = 3000) => { clearTimeout(timer); timer = setTimeout(() => uploadSchedule().catch(() => {}), ms); };

export async function initPush() {
  // 前回の登録が残っていればこの端末は受け取り中。ログイン後に宛先をサーバーへ念のため登録し直す
  const sub = await currentSub().catch(() => null);
  active = !!sub && Notification.permission === 'granted';
  let savedFor = null;
  Sync.onStatus(() => {
    const user = Sync.currentUser();
    if (!user || Sync.status.state !== 'ok') return;
    if (active && savedFor !== user.id) { savedFor = user.id; currentSub().then(s => s && saveSub(s)).catch(() => {}); }
    scheduleUpload(500);
  });
  S.subscribe(() => scheduleUpload());
  setInterval(() => scheduleUpload(0), 15 * 60000);
}
