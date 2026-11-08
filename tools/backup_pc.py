"""Today's Path を PC にバックアップする（Windows のタスク スケジューラから週 1 回実行）。

  python backup_pc.py           バックアップを作る
  python backup_pc.py --setup   最初の 1 回だけ。鍵を作って backup-key.secret に保存し、登録用の値（SHA-256）を表示する

保存先はこのファイルと同じフォルダ。出力はアプリの「設定 → バックアップ → 読み込み」でそのまま戻せる JSON と、
人が読むための一覧（.md）。繰り返しの予定・todo は基準の 1 件（繰り返しの規則つき）として保存される。
"""
import datetime, hashlib, json, pathlib, secrets, sys, urllib.request

SUPABASE_URL = 'https://jqdwdnwamgvjigrxvndr.supabase.co'
# 公開用の anon キー（アプリの js/config.js と同じ）。中身を読むには別に鍵ファイルが要る
ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxZHdkbndhbWd2amlncnh2bmRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzNzg5NjAsImV4cCI6MjEwODk1NDk2MH0.YNu8-xxRgRnMdOOmKj9_B8816t24boIQxgkFFCdiF0U'
KEEP = 26                      # 残す週数（約半年）

DIR = pathlib.Path(__file__).resolve().parent
KEY_FILE = DIR / 'backup-key.secret'
LOG = DIR / 'backup.log'
FREQ = {'day': '日', 'week': '週', 'month': 'か月', 'year': '年'}


def log(msg):
    line = f'{datetime.datetime.now():%Y-%m-%d %H:%M} {msg}'
    with LOG.open('a', encoding='utf-8') as f:
        f.write(line + '\n')
    try:
        print(line)
    except Exception:  # 画面の無い実行（タスク スケジューラ）や文字コードの違いでは表示しない
        pass


def setup():
    if KEY_FILE.exists():
        token = KEY_FILE.read_text(encoding='utf-8').strip()
    else:
        token = secrets.token_urlsafe(32)
        KEY_FILE.write_text(token, encoding='utf-8')
    print(hashlib.sha256(token.encode()).hexdigest())


def fetch(token):
    req = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/rpc/export_items',
        data=json.dumps({'token': token}).encode(),
        headers={'apikey': ANON_KEY, 'Authorization': f'Bearer {ANON_KEY}', 'Content-Type': 'application/json'},
        method='POST')
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)


def to_state(rows):
    """items テーブルの行を、アプリの書き出しと同じ形にする"""
    pick = lambda kind: [r['data'] for r in rows if r['kind'] == kind]
    setting = lambda i: next((r['data'] for r in rows if r['kind'] == 'settings' and r['id'] == i), None)
    return {
        'version': 1,
        'tabs': sorted(pick('tab'), key=lambda t: t.get('pos', 0)),
        'todos': pick('todo'), 'events': pick('event'), 'inbox': pick('inbox'),
        'settings': setting('main') or {},
        'meta': {'checkDone': (setting('meta') or {}).get('checkDone', '')},
    }


def repeat_text(rep):
    if not rep or rep.get('freq', 'none') == 'none':
        return ''
    n = rep.get('interval') or 1
    unit = FREQ.get(rep['freq'], rep['freq'])
    text = f'毎{unit}' if n == 1 else f'{n}{unit}ごと'
    until = f"・{rep['until']}まで" if rep.get('until') else ''
    return f'（繰り返し: {text}{until}）'


def summary(state, day):
    tabs = {t['id']: t['name'] for t in state['tabs']}
    lines = [f"# Today's Path バックアップ {day}", '',
             f"予定 {len(state['events'])} 件 / todo {len(state['todos'])} 件", '', '## 予定']
    for e in sorted(state['events'], key=lambda e: e.get('start', '')):
        when = e['start'] if e.get('allDay') else f"{e['start'].replace('T', ' ')}–{e.get('end', '')[11:]}"
        place = f" @{e['location']}" if e.get('location') else ''
        skip = f"（この日だけ削除: {', '.join(e['exdates'])}）" if e.get('exdates') else ''
        lines.append(f"- {when} {e.get('title', '')}{place}{repeat_text(e.get('repeat'))}{skip}")
    lines += ['', '## todo']
    for t in sorted(state['todos'], key=lambda t: (t.get('done', False), t.get('due') or '9999')):
        due = f" 期限 {t['due'].replace('T', ' ')}" if t.get('due') else ''
        mark = 'x' if t.get('done') else ' '
        rep = repeat_text(t.get('repeat')) if t.get('due') else ''
        lines.append(f"- [{mark}] {t.get('title', '')}［{tabs.get(t.get('tabId'), '')}］{due}{rep}")
    return '\n'.join(lines) + '\n'


def backup():
    if not KEY_FILE.exists():
        log('鍵ファイル backup-key.secret がありません（--setup を実行してください）')
        return 1
    try:
        rows = fetch(KEY_FILE.read_text(encoding='utf-8').strip())
    except Exception as e:  # 通信できないときは次回に回す（古いバックアップは消さない）
        log(f'取得できませんでした: {e}')
        return 1
    state = to_state(rows)
    day = datetime.date.today().isoformat()
    (DIR / f'todays-path-{day}.json').write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
    (DIR / f'todays-path-{day}.md').write_text(summary(state, day), encoding='utf-8')
    # 古いものを消すのは、今回きちんと中身が取れたときだけ
    if state['events'] or state['todos']:
        for ext in ('json', 'md'):
            for old in sorted(DIR.glob(f'todays-path-*.{ext}'), reverse=True)[KEEP:]:
                old.unlink()
    log(f"保存しました: 予定 {len(state['events'])} 件 / todo {len(state['todos'])} 件")
    return 0


if __name__ == '__main__':
    sys.exit(setup() if '--setup' in sys.argv else backup())
