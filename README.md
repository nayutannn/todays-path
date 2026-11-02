# Today's Path

自分専用のカレンダー＋ToDo アプリ（PWA）。PC のブラウザと iPhone のホーム画面で使う。

- 予定・todo は Supabase に保存され、ログインした本人だけが読み書きできる（`supabase/schema.sql`）
- `js/config.js` の anon キーは公開前提のキー。service_role キーやパスワードはこのリポジトリに入れない
