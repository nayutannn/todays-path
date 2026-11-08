// 日本の祝日（「国民の祝日に関する法律」の規則から計算するので、毎年の更新は要らない）
// 法律そのものが変わったときだけ、ここを直す。対象は 2020〜2099 年
import { ymd, addDays, parse } from './util.js';

const cache = new Map();

// n 番目の月曜日
const nthMonday = (y, m, n) => {
  const first = new Date(y, m - 1, 1);
  return 1 + ((8 - first.getDay()) % 7) + (n - 1) * 7;
};
// 春分・秋分の日（1980〜2099 年で使われている近似式）
const shunbun = y => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
const shubun = y => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

function build(y) {
  const map = new Map();
  const set = (m, d, name) => map.set(ymd(new Date(y, m - 1, d)), name);
  set(1, 1, '元日');
  set(1, nthMonday(y, 1, 2), '成人の日');
  set(2, 11, '建国記念の日');
  set(2, 23, '天皇誕生日');
  set(3, shunbun(y), '春分の日');
  set(4, 29, '昭和の日');
  set(5, 3, '憲法記念日');
  set(5, 4, 'みどりの日');
  set(5, 5, 'こどもの日');
  // 東京五輪の年だけ日付が動いた
  if (y === 2020) { set(7, 23, '海の日'); set(7, 24, 'スポーツの日'); set(8, 10, '山の日'); }
  else if (y === 2021) { set(7, 22, '海の日'); set(7, 23, 'スポーツの日'); set(8, 8, '山の日'); }
  else { set(7, nthMonday(y, 7, 3), '海の日'); set(8, 11, '山の日'); set(10, nthMonday(y, 10, 2), 'スポーツの日'); }
  set(9, nthMonday(y, 9, 3), '敬老の日');
  set(9, shubun(y), '秋分の日');
  set(11, 3, '文化の日');
  set(11, 23, '勤労感謝の日');

  const base = [...map.keys()].sort();
  // 国民の休日: 祝日にはさまれた平日
  for (const k of base) {
    const next = ymd(addDays(parse(k), 2));
    const mid = ymd(addDays(parse(k), 1));
    if (map.has(next) && !map.has(mid) && parse(mid).getDay() !== 0) map.set(mid, '国民の休日');
  }
  // 振替休日: 祝日が日曜なら、その後の最初の祝日でない日
  for (const k of base) {
    if (parse(k).getDay() !== 0) continue;
    let d = addDays(parse(k), 1);
    while (map.has(ymd(d))) d = addDays(d, 1);
    map.set(ymd(d), '振替休日');
  }
  return map;
}

// 'YYYY-MM-DD' → 祝日名（祝日でなければ空文字）
export function holidayName(key) {
  const y = +key.slice(0, 4);
  if (!cache.has(y)) cache.set(y, build(y));
  return cache.get(y).get(key) || '';
}
