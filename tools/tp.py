"""Claude が PC から Today's Path を読み書きするための道具（ブラウザなしで使える）。

  python tools/tp.py dump [--from YYYY-MM-DD] [--to YYYY-MM-DD]
      タグ・リスト・予定（期間内。繰り返しは基準の 1 件と規則）・未完了の todo・確認待ちを JSON で表示
  python tools/tp.py add FILE.json [--dry-run]
      FILE の操作の一覧を順に行う（下の書式）。似た予定・todo が既にあるものは追加せず skip と表示する

操作の書式（JSON の配列）:
  {"type": "event", "title": "...", "start": "2026-11-20T10:00", "end": "2026-11-20T11:30", "allDay": false,
   "location": "", "tags": ["学校"], "memo": "", "reminders": [10], "source": "iCloudメール: 件名"}
  {"type": "todo", "title": "...", "tab": "全般", "due": "2026-11-20T23:55", "doDate": "", "priority": 0,
   "longLead": 0, "memo": "", "reminders": ["d0@12:00"], "source": "Teams: 〇〇"}
  {"type": "ask", "kind": "event" | "todo", ...上と同じ項目..., "reason": "迷った理由", "replaces": "既にある項目の id（任意）"}
  "force": true を付けると、似た項目があっても追加する

鍵は backup/backup-key.secret（週 1 バックアップと同じ）。サーバー側は supabase/claude-write.sql の put_items。
既にある項目の書き換え・削除はできない（変更は ask + replaces で確認待ちに入れる）。
"""
import datetime, json, pathlib, random, re, string, sys, time, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from backup_pc import SUPABASE_URL, ANON_KEY, KEY_FILE, to_state  # noqa: E402

DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
DATETIME = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$')
REM = re.compile(r'^d-?\d+@\d{2}:\d{2}$')
NONE = {'freq': 'none', 'interval': 1, 'until': ''}


def rpc(name, payload):
    req = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/rpc/{name}', data=json.dumps(payload).encode(),
        headers={'apikey': ANON_KEY, 'Authorization': f'Bearer {ANON_KEY}', 'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)


def token():
    return KEY_FILE.read_text(encoding='utf-8').strip()


def load_state():
    return to_state(rpc('export_items', {'token': token()}))


def uid(p):
    n, s = int(time.time() * 1000), ''
    while n:
        n, r = divmod(n, 36)
        s = '0123456789abcdefghijklmnopqrstuvwxyz'[r] + s
    return f"{p}_{s}{''.join(random.choices(string.ascii_lowercase + string.digits, k=5))}"


def now_iso():
    t = datetime.datetime.now(datetime.timezone.utc)
    return t.strftime('%Y-%m-%dT%H:%M:%S.') + f'{t.microsecond // 1000:03d}Z'


def norm(s):
    return re.sub(r'[\s　・\-ー（）()「」【】]', '', str(s or '')).lower()


def similar(a, b):
    a, b = norm(a), norm(b)
    return bool(a and b and (a in b or b in a))


def day_of(s):
    return (s or '')[:10]


# ---------- 予定の発生日（繰り返しも簡単に展開。重複チェックと dump 用） ----------
def occurrences(ev, start, end):
    """ev が start〜end（日付文字列、end を含む）に掛かる日の一覧（開始日）"""
    s = datetime.date.fromisoformat(day_of(ev['start']))
    e = datetime.date.fromisoformat(day_of(ev.get('end') or ev['start']))
    dur = max(0, (e - s).days)
    a, b = datetime.date.fromisoformat(start), datetime.date.fromisoformat(end)
    rep = ev.get('repeat') or NONE
    freq, n = rep.get('freq', 'none'), max(1, int(rep.get('interval') or 1))
    until = datetime.date.fromisoformat(rep['until']) if rep.get('until') else None
    ex = set(ev.get('exdates') or [])
    out = []
    for k in range(0, 3000):
        if freq == 'none':
            d = s if k == 0 else None
        elif freq == 'day':
            d = s + datetime.timedelta(days=n * k)
        elif freq == 'week':
            d = s + datetime.timedelta(days=7 * n * k)
        else:
            months = n * k * (12 if freq == 'year' else 1)
            y, m = divmod(s.month - 1 + months, 12)
            y += s.year
            import calendar
            d = datetime.date(y, m + 1, min(s.day, calendar.monthrange(y, m + 1)[1]))
        if d is None or d > b or (until and d > until):
            break
        if d + datetime.timedelta(days=dur) >= a and d.isoformat() not in ex:
            out.append(d.isoformat())
    return out


def dump(args):
    st = load_state()
    today = datetime.date.today()
    a = args.get('--from') or (today - datetime.timedelta(days=7)).isoformat()
    b = args.get('--to') or (today + datetime.timedelta(days=180)).isoformat()
    tabs = {t['id']: t['name'] for t in st['tabs']}
    events = []
    for e in st['events']:
        days = occurrences(e, a, b)
        if not days:
            continue
        x = {k: e.get(k) for k in ('id', 'title', 'start', 'end', 'allDay', 'location', 'tags', 'source') if e.get(k) not in (None, '', [])}
        if e.get('memo'):
            x['memo'] = e['memo'][:200]
        if (e.get('repeat') or {}).get('freq', 'none') != 'none':
            x['repeat'] = e['repeat']
            x['dates'] = days[:20]
        events.append(x)
    todos = [{**{k: t.get(k) for k in ('id', 'title', 'due', 'doDate', 'priority', 'source') if t.get(k) not in (None, '', 0)},
              'tab': tabs.get(t.get('tabId'), '')} for t in st['todos'] if not t.get('done')]
    inbox = [{'id': i['id'], 'kind': i['kind'], 'title': i['data'].get('title'), 'start': i['data'].get('start') or i['data'].get('due'),
              'reason': i.get('reason')} for i in st['inbox']]
    s = st['settings']
    print(json.dumps({
        'range': [a, b], 'tags': s.get('tags') or [], 'workTag': s.get('workTag', 'バイト'), 'defaultWage': s.get('defaultWage'),
        'tabs': [t['name'] for t in st['tabs']],
        'events': sorted(events, key=lambda x: x['start']), 'todos': todos, 'inbox': inbox,
    }, ensure_ascii=False, indent=1))


# ---------- 追加 ----------
def check_rem(rems):
    for r in rems:
        if not (isinstance(r, int) or (isinstance(r, str) and REM.match(r))):
            raise ValueError(f'reminders の値が不正です: {r!r}（分数か "d0@12:00" の形）')
    return rems


def event_data(x, st):
    all_day = bool(x.get('allDay')) or bool(DATE.match(x.get('start', '')))
    pat = DATE if all_day else DATETIME
    ev = {'title': str(x.get('title', '')).strip(), 'allDay': all_day, 'start': x.get('start', ''), 'end': x.get('end') or x.get('start', ''),
          'location': x.get('location', ''), 'memo': x.get('memo', ''), 'tags': list(x.get('tags') or []),
          'repeat': {**NONE, **(x.get('repeat') or {})}, 'reminders': check_rem(x.get('reminders', [] if all_day else [10]))}
    if not ev['title']:
        raise ValueError('title がありません')
    if not pat.match(ev['start']) or not pat.match(ev['end']):
        raise ValueError('終日は YYYY-MM-DD、時間ありは YYYY-MM-DDTHH:MM で start/end を指定してください')
    if ev['end'] < ev['start']:
        raise ValueError('終了が開始より前です')
    work = st['settings'].get('workTag', 'バイト')
    if work in ev['tags']:
        ev['wage'] = x.get('wage', st['settings'].get('defaultWage', 1100))
        ev['breakMin'] = x.get('breakMin', 0)
    return ev


def todo_data(x, st):
    tab = next((t['id'] for t in st['tabs'] if t['name'] == x.get('tab') or t['id'] == x.get('tab')), st['tabs'][0]['id'] if st['tabs'] else 'tab_main')
    t = {'title': str(x.get('title', '')).strip(), 'tabId': tab, 'due': x.get('due', ''), 'doDate': x.get('doDate', ''),
         'priority': min(3, max(0, int(x.get('priority') or 0))),
         'repeat': {'freq': 'none', 'interval': 1, **(x.get('repeat') or {})} if x.get('due') else {'freq': 'none', 'interval': 1},
         'longLead': int(x.get('longLead') or 0), 'context': x.get('context', ''), 'memo': x.get('memo', ''),
         'reminders': check_rem(x.get('reminders', []))}
    if not t['title']:
        raise ValueError('title がありません')
    if t['due'] and not DATETIME.match(t['due']):
        raise ValueError('due は YYYY-MM-DDTHH:MM')
    if t['doDate'] and not DATE.match(t['doDate']):
        raise ValueError('doDate は YYYY-MM-DD')
    return t


def similar_events(ev, st):
    d = day_of(ev['start'])
    return [e for e in st['events'] if similar(e.get('title'), ev['title']) and occurrences(e, d, d)]


def similar_todos(t, st):
    return [x for x in st['todos'] if not x.get('done') and similar(x.get('title'), t['title'])]


def add(path, dry):
    ops = json.loads(pathlib.Path(path).read_text(encoding='utf-8-sig'))
    st = load_state()
    rows, report, names = [], [], []
    stamp = now_iso()
    order = max([t.get('order', 0) or 0 for t in st['todos']] + [0])
    for i, x in enumerate(ops):
        kind = x.get('kind') if x.get('type') == 'ask' else x.get('type')
        try:
            if kind not in ('event', 'todo'):
                raise ValueError('type は event / todo / ask（ask は kind も）')
            data = event_data(x, st) if kind == 'event' else todo_data(x, st)
            source = x.get('source') or 'claude'
            if x.get('type') == 'ask':
                if x.get('replaces') and not any(e['id'] == x['replaces'] for e in st['events' if kind == 'event' else 'todos']):
                    raise ValueError('replaces の id が見つかりません')
                row = {'id': uid('ib'), 'kind': kind, 'data': data, 'reason': x.get('reason', ''), 'source': source,
                       'replaces': x.get('replaces'), 'createdAt': stamp}
                rows.append({'kind': 'inbox', 'id': row['id'], 'data': row})
                report.append(f'[{i}] 確認待ち: {data["title"]}')
                continue
            dup = similar_events(data, st) if kind == 'event' else similar_todos(data, st)
            if dup and not x.get('force'):
                report.append(f'[{i}] skip（似た項目あり）: {data["title"]} ← ' + ', '.join(f'{d["id"]} {d["title"]} {d.get("start") or d.get("due", "")}' for d in dup))
                continue
            p = 'ev' if kind == 'event' else 'td'
            item = {**data, 'id': uid(p), 'createdAt': stamp, 'updatedAt': stamp, 'source': source, 'claudeNew': True}
            if kind == 'todo':
                order += 1
                item.update({'done': False, 'order': order})
            rows.append({'kind': kind, 'id': item['id'], 'data': item})
            (st['events'] if kind == 'event' else st['todos']).append(item)   # 同じファイル内の重複も防ぐ
            names.append(f'{"予定" if kind == "event" else "todo"}「{data["title"]}」')
            report.append(f'[{i}] 追加: {data["title"]} ({item["id"]})')
        except ValueError as e:
            report.append(f'[{i}] エラー: {e}')
    print('\n'.join(report) or '操作がありません')
    if dry or not rows:
        print('（書き込みなし）' if dry else '')
        return 0
    title = f'Claude が{len(names)}件追加しました' if names else None
    body = '、'.join(names[:3]) + (' ほか' if len(names) > 3 else '')
    n = rpc('put_items', {'token': token(), 'rows': rows, 'notice_title': title, 'notice_body': body})
    print(f'書き込み {n} 件')
    return 0


def main(argv):
    if len(argv) < 2 or argv[1] not in ('dump', 'add'):
        print(__doc__)
        return 1
    args = dict(zip(argv[2::2], argv[3::2]))
    if argv[1] == 'dump':
        dump(args)
        return 0
    return add(argv[2], '--dry-run' in argv)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main(sys.argv))
