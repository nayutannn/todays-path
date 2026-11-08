-- Claude（PC の定期実行）が予定・todo・確認待ちを追加するための入口
-- PC の backup/backup-key.secret の鍵（export_tokens に SHA-256 を登録済み）で本人を確かめる。
-- 新しい項目を「足す」ことしかできない（既にある項目の書き換え・削除はできない）。変更の提案は確認待ち（inbox）経由。
-- SQL Editor に全文を貼り付けて Run（何度実行しても安全）

create or replace function public.put_items(token text, rows jsonb, notice_title text default null, notice_body text default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  uid uuid;
  n int;
  minute timestamptz := date_trunc('minute', now());
begin
  update public.export_tokens set last_used = now()
   where token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex')
  returning user_id into uid;
  if uid is null then raise exception 'invalid token'; end if;
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) > 200 then raise exception 'rows must be an array (max 200)'; end if;

  insert into public.items (user_id, kind, id, data, deleted, updated_at)
  select uid, r->>'kind', r->>'id', r->'data', false, now()
    from jsonb_array_elements(rows) r
   where r->>'kind' in ('event', 'todo', 'inbox')
     and coalesce(r->>'id', '') <> '' and jsonb_typeof(r->'data') = 'object'
  on conflict (user_id, kind, id) do nothing;
  get diagnostics n = row_count;

  -- 追加したことをプッシュ通知で知らせる（アプリ側の予定表と同じ key にして二重に届かないようにする）
  if n > 0 and notice_title is not null then
    update public.push_schedule
       set items = coalesce(items, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'key', 'claude:' || to_char(minute at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI'),
             'at', to_char((minute + interval '1 minute') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'title', notice_title, 'body', coalesce(notice_body, ''), 'tag', 'claude', 'url', './#path'))
     where user_id = uid;
  end if;
  return n;
end $$;
revoke all on function public.put_items(text, jsonb, text, text) from public;
grant execute on function public.put_items(text, jsonb, text, text) to anon, authenticated;
