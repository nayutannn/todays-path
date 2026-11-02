# Today's Path

自分専用のカレンダー＋ToDo アプリ（PWA）。PC のブラウザと iPhone のホーム画面で使う。

- 予定・todo は Supabase に保存され、ログインした本人だけが読み書きできる（`supabase/schema.sql`）
- `js/config.js` の anon キーは公開前提のキー。service_role キーやパスワードはこのリポジトリに入れない
- アプリを閉じていても届く通知: アプリが「いつ何を通知するか」を `push_schedule` に置き、Edge Function `send-push`（`supabase/functions/send-push`）を `supabase/cron.sql` で 1 分ごとに呼んで送る。VAPID 秘密鍵は Supabase の Secrets にだけ置く
