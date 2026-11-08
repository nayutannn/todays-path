"""iCloud メールの新着（受信・送信済み）を PC に取り込む。迷惑メールのフォルダは読まない。

  python tools/mail_fetch.py --setup   最初の 1 回だけ（本人が実行）。Apple ID と App 用パスワードを入力して保存し、接続を確かめる
  python tools/mail_fetch.py           新着を mail-data/new/ に保存（既読にはしない）
  python tools/mail_fetch.py --done    mail-data/new/ の中身を mail-data/done/ へ移す（Claude が読み終えたあと）

保存先（.gitignore 済み・OneDrive の外）:
  mail-data/new/<日付>_<受信|送信>_<番号>/message.md     差出人・宛先・件名・本文
  mail-data/new/<...>/attachments/                        添付ファイル（Word/Excel/PowerPoint は中身の文字を .txt にも書き出す）
message.md の「宣伝の可能性」は、一括配信の印（List-Unsubscribe など）があるときに「あり」になる。判断は読む側が行う。
"""
import datetime, email, email.header, email.policy, email.utils, getpass, html, imaplib, json, pathlib, re, shutil, sys, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / 'mail-data'
NEW, DONE = DATA / 'new', DATA / 'done'
SECRET = DATA / 'icloud.secret'
STATE = DATA / 'state.json'
HOST = 'imap.mail.me.com'
FIRST_DAYS = 14               # 初回はこの日数ぶんさかのぼる
KEEP_DONE_DAYS = 30
MAX_ATTACH = 25 * 1024 * 1024


def say(msg):
    try:
        print(msg)
    except Exception:
        pass


def login():
    cred = json.loads(SECRET.read_text(encoding='utf-8'))
    m = imaplib.IMAP4_SSL(HOST, 993)
    m.login(cred['user'], cred['password'])
    return m


def setup():
    DATA.mkdir(exist_ok=True)
    say('iCloud メールの読み取りを設定します。入力した内容はこの PC の mail-data/icloud.secret にだけ保存されます。')
    say('パスワードは Apple ID のものではなく、account.apple.com で作る「App 用パスワード」を使ってください。')
    user = input('Apple ID（メールアドレス）: ').strip()
    pw = getpass.getpass('App 用パスワード（入力しても表示されません）: ').strip()
    SECRET.write_text(json.dumps({'user': user, 'password': pw}), encoding='utf-8')
    try:
        m = login()
        say('接続できました。フォルダ: ' + ', '.join(name for name, _ in folders(m)))
        m.logout()
    except Exception as e:
        say(f'接続できませんでした: {e}')
        return 1
    return 0


def folders(m):
    """読むフォルダ（受信箱と送信済み）。迷惑メール・ゴミ箱・下書きは読まない"""
    out = [('INBOX', '受信')]
    _, lines = m.list()
    for raw in lines or []:
        line = raw.decode('utf-8', 'replace')
        name = re.search(r'"?([^"]+)"?\s*$', line).group(1)
        if '\\Sent' in line or name in ('Sent Messages', 'Sent'):
            out.append((name, '送信'))
            break
    return out


def dec(s):
    if not s:
        return ''
    try:
        return str(email.header.make_header(email.header.decode_header(s)))
    except Exception:
        return s


def html_to_text(s):
    s = re.sub(r'(?is)<(script|style).*?</\1>', '', s)
    s = re.sub(r'(?i)<br\s*/?>|</p>|</div>|</tr>|</li>', '\n', s)
    s = re.sub(r'<[^>]+>', '', s)
    s = html.unescape(s)
    return re.sub(r'\n\s*\n+', '\n\n', s).strip()


def office_text(path):
    """docx / xlsx / pptx の中の文字を取り出す（標準ライブラリだけで）"""
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            ext = path.suffix.lower()
            if ext == '.docx':
                parts = ['word/document.xml']
            elif ext == '.pptx':
                parts = sorted((n for n in names if re.match(r'ppt/slides/slide\d+\.xml$', n)), key=lambda n: int(re.findall(r'\d+', n)[-1]))
            elif ext == '.xlsx':
                parts = ['xl/sharedStrings.xml'] + sorted(n for n in names if n.startswith('xl/worksheets/sheet'))
            else:
                return None
            out = []
            for p in parts:
                if p not in names:
                    continue
                xml = z.read(p).decode('utf-8', 'replace')
                xml = re.sub(r'</(w:p|a:p|row|si)>', '\n', xml)
                xml = re.sub(r'<(w:tab|c )[^>]*/?>', '\t', xml)
                out.append(html.unescape(re.sub(r'<[^>]+>', '', xml)))
            return '\n'.join(out).strip()
    except Exception as e:
        return f'（中身を読み取れませんでした: {e}）'


def safe_name(s):
    s = re.sub(r'[\\/:*?"<>|\r\n\t]', '_', s).strip() or 'file'
    return s[:120]


def save_message(raw, label, uid):
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    try:
        when = email.utils.parsedate_to_datetime(msg['Date']).astimezone()
    except Exception:
        when = datetime.datetime.now().astimezone()
    d = NEW / f'{when:%Y-%m-%d_%H%M}_{label}_{uid}'
    d.mkdir(parents=True, exist_ok=True)
    plain, htm, files = [], [], []
    for part in msg.walk():
        if part.is_multipart():
            continue
        fname = part.get_filename()
        ctype = part.get_content_type()
        if fname or part.get_content_disposition() == 'attachment':
            payload = part.get_payload(decode=True) or b''
            name = safe_name(dec(fname) or f'attachment.{ctype.split("/")[-1]}')
            if len(payload) > MAX_ATTACH:
                files.append(f'{name}（{len(payload) // 1024 // 1024}MB・大きすぎるので保存せず）')
                continue
            ad = d / 'attachments'
            ad.mkdir(exist_ok=True)
            p = ad / name
            p.write_bytes(payload)
            txt = office_text(p) if p.suffix.lower() in ('.docx', '.xlsx', '.pptx') else None
            if txt:
                (ad / (name + '.txt')).write_text(txt, encoding='utf-8')
            files.append(name)
        elif ctype == 'text/plain':
            plain.append(part.get_content())
        elif ctype == 'text/html':
            htm.append(part.get_content())
    body = '\n\n'.join(plain).strip() or html_to_text('\n'.join(htm))
    promo = any(msg.get(h) for h in ('List-Unsubscribe', 'List-Id')) or (msg.get('Precedence', '').lower() in ('bulk', 'list'))
    md = [f'# {dec(msg["Subject"]) or "（件名なし）"}', '',
          f'- 種類: {label}', f'- 日時: {when:%Y-%m-%d %H:%M}', f'- 差出人: {dec(msg["From"])}', f'- 宛先: {dec(msg["To"])}']
    if msg['Cc']:
        md.append(f'- CC: {dec(msg["Cc"])}')
    md += [f'- 宣伝の可能性: {"あり（一括配信の印がある）" if promo else "なし"}',
           f'- 添付: {", ".join(files) if files else "なし"}', '', '---', '', body[:30000]]
    (d / 'message.md').write_text('\n'.join(md), encoding='utf-8')
    return d


def fetch():
    if not SECRET.exists():
        say('まだ設定されていません。本人が `python tools/mail_fetch.py --setup` を実行してください')
        return 1
    NEW.mkdir(parents=True, exist_ok=True)
    state = json.loads(STATE.read_text(encoding='utf-8')) if STATE.exists() else {}
    m = login()
    saved = 0
    for name, label in folders(m):
        typ, data = m.select(f'"{name}"', readonly=True)   # readonly: 既読にしない
        if typ != 'OK':
            continue
        validity = m.response('UIDVALIDITY')[1][0].decode()
        st = state.get(name, {})
        if st.get('validity') != validity:
            since = (datetime.date.today() - datetime.timedelta(days=FIRST_DAYS)).strftime('%d-%b-%Y')
            _, res = m.uid('search', None, f'SINCE {since}')
            st = {'validity': validity, 'last': 0}
        else:
            _, res = m.uid('search', None, f'UID {st["last"] + 1}:*')
        uids = [int(x) for x in (res[0] or b'').split() if int(x) > st['last']]
        for u in uids:
            _, msgdata = m.uid('fetch', str(u), '(BODY.PEEK[])')
            raw = next((p[1] for p in msgdata if isinstance(p, tuple)), None)
            if raw:
                save_message(raw, label, u)
                saved += 1
            st['last'] = max(st['last'], u)
        state[name] = st
    m.logout()
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding='utf-8')
    say(f'新着 {saved} 通を保存しました（未処理: {len(list(NEW.iterdir()))} 通）')
    return 0


def done():
    DONE.mkdir(parents=True, exist_ok=True)
    for d in NEW.iterdir() if NEW.exists() else []:
        shutil.move(str(d), str(DONE / d.name))
    limit = datetime.datetime.now().timestamp() - KEEP_DONE_DAYS * 86400
    for d in DONE.iterdir():
        if d.stat().st_mtime < limit:
            shutil.rmtree(d, ignore_errors=True)
    say('処理済みに移しました')
    return 0


if __name__ == '__main__':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    sys.exit(setup() if '--setup' in sys.argv else done() if '--done' in sys.argv else fetch())
