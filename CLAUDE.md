# Today's Path — Claude 向けの作業メモ

ユーザー専用のカレンダー＋ToDo（PWA）。公開URL: https://nayutannn.github.io/todays-path/
返答は常に日本語。todoリストの1項目は「todo」と呼ぶ。

## 写真から予定・todoを追加する手順
ユーザーがチャットに写真（プリント、時間割、シフト表、掲示、スクショなど）を貼ったとき。

1. **読み取る**: 写真の中の日付・時刻・場所・持ち物・締切をすべて書き出す。年が書かれていなければ、今日以降で一番近い日付と考える。
2. **振り分ける**（「自動または私に確認したうえで」の方針）
   - **確実に本人に関係があり、日時がはっきりしている** → 直接追加する（`TP.addEvent` / `TP.addTodo`）
   - **本人に関係があるか、日時や内容が曖昧** → 確認待ちに入れる（`TP.ask`）。`reason` に迷った点を短く書く（例:「対象クラスが写真から読めない」）
   - **明らかに本人に関係がない**（他学年・他クラス・他部活向けなど） → 追加しない。ただし何を飛ばしたかは返答で伝える
   - 本人の学年・クラス・部活・バイト先などが分からず判断できないときは、チャットでユーザーに聞く。聞いた内容はメモリーに残す
3. **書き込む**: 内蔵ブラウザで公開URLを開き、`javascript_tool` で `window.TP` を呼ぶ。
   - 最初に `TP.status()` で `user` が入っている（ログイン済み）ことと、`sync` が `ok` であることを確認する。未ログインならユーザーに、ブラウザ画面の「設定」で本人がログインするよう頼む（パスワードを聞いたり入力したりしない）
   - 追加前に `TP.events(from, to)` や `TP.search(語)` で既にある予定を確かめる
   - `addEvent` / `addTodo` は、重複（`duplicates`）やダブルブッキング（`conflicts`）があると保存せずに `ok:false` を返す。重複ならスキップし、ダブルブッキングはユーザーに伝えて判断を仰ぐ（必要なら `{ force: true }`）
   - 書き込んだら `await TP.sync()` で `ok` を確認する
4. **報告する**: 追加したもの・確認待ちに入れたもの（理由つき）・飛ばしたものを、短い一覧で伝える。

## TP の使い方
```js
TP.status()                                  // { user, sync, events, todos, inbox, tabs, workTag, defaultWage }
TP.events('2026-11-10', '2026-11-16')        // 期間内の予定（繰り返しも展開済み）
TP.todos()                                   // 未完了の todo
TP.search('数学')                            // 予定・todo の名前検索
TP.addEvent({ title, start, end, allDay, location, tags, memo, reminders, repeat, wage, breakMin })
TP.addTodo({ title, tab, due, doDate, priority, longLead, context, memo, reminders, repeat })
TP.ask('event' | 'todo', { ...上と同じ }, '迷った理由')
await TP.sync()
```
- 日時は端末の時刻（日本時間）で `YYYY-MM-DDTHH:MM`、終日・やる日は `YYYY-MM-DD`
- `tags` に `'バイト'`（`TP.status().workTag`）を入れるとバイトの予定になり、`wage`（時給）・`breakMin`（休憩分）を持てる
- `reminders` は「何分前に通知するか」の配列（例: `[10]`、前日なら `[1440]`）。予定は省略すると10分前
- todo の `tab` はリスト名。無い名前なら新しいリストができる
- `priority` は 0〜3（なし・低・中・高）、`longLead` は長期タスク（3・7・14・30 日前から Today's Path に表示）
- 提出物のように「締切」があるものは todo（`due`）、時間が決まっている行事は予定にする。行事の準備（持ち物など）は、行事の前日を `doDate` にした todo にする

## 開発メモ
- ビルドなしの ES modules。ローカル確認は `python -m http.server 8765 -d todays-path`（`.claude/launch.json` の `todays-path`）
- データは `js/store.js`、Supabase 同期は `js/sync.js`、通知は `js/push.js` と `supabase/functions/send-push`
- `vapid.secret` は秘密鍵。読まない・表示しない・コミットしない
