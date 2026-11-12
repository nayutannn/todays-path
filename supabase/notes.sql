-- Claude の調査メモ（調査結果・仮説検証の記録）の置き場
-- 予定・todo（items）とは別の表にして、端末の保存容量と毎日のバックアップを圧迫しないようにする。
-- 書き込みは PC の Claude だけ（backup/backup-key.secret の鍵で本人を確かめる put_notes）。アプリは読むだけ。
-- 元の文章は PC の C:\Users\Osaka\research-notes（git で履歴あり）にあり、ここはその写し。
-- SQL Editor に全文を貼り付けて Run（何度実行しても安全）

create table if not exists public.notes (
  user_id    uuid        not null references auth.users on delete cascade,
  id         text        not null,
  meta       jsonb       not null,              -- { title, status, keywords[], links[{kind,id}], summary, created, updated }
  body       text        not null default '',   -- Markdown
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.notes enable row level security;
grant select on public.notes to authenticated;
drop policy if exists "own notes" on public.notes;
create policy "own notes" on public.notes for select using (auth.uid() = user_id);

-- rows: [{ "id": "nt_...", "meta": {...}, "body": "...", "deleted": false }]
-- 1 件 300KB まで、合計 30MB まで（無料枠 500MB を圧迫しないため）。超えたら全体を取り消す
create or replace function public.put_notes(token text, rows jsonb, notice_title text default null, notice_body text default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  uid uuid;
  n int := 0;
  m int;
  minute timestamptz := date_trunc('minute', now());
begin
  update public.export_tokens set last_used = now()
   where token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex')
  returning user_id into uid;
  if uid is null then raise exception 'invalid token'; end if;
  if jsonb_typeof(rows) <> 'array' or jsonb_array_length(rows) > 100 then raise exception 'rows must be an array (max 100)'; end if;

  delete from public.notes
   where user_id = uid and id in (select r->>'id' from jsonb_array_elements(rows) r where (r->>'deleted')::boolean is true);
  get diagnostics m = row_count;
  n := n + m;

  insert into public.notes (user_id, id, meta, body, updated_at)
  select uid, r->>'id', r->'meta', coalesce(r->>'body', ''), now()
    from jsonb_array_elements(rows) r
   where (r->>'deleted')::boolean is not true
     and r->>'id' like 'nt\_%' and jsonb_typeof(r->'meta') = 'object'
  on conflict (user_id, id) do update set meta = excluded.meta, body = excluded.body, updated_at = now();
  get diagnostics m = row_count;
  n := n + m;

  if exists (select 1 from public.notes where user_id = uid and octet_length(body) + octet_length(meta::text) > 300000) then
    raise exception 'note too large (max 300KB)';
  end if;
  if (select coalesce(sum(octet_length(body) + octet_length(meta::text)), 0) from public.notes where user_id = uid) > 30000000 then
    raise exception 'notes total too large (max 30MB)';
  end if;

  if n > 0 and notice_title is not null then
    update public.push_schedule
       set items = coalesce(items, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'key', 'claude-note:' || to_char(minute at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI'),
             'at', to_char((minute + interval '1 minute') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'title', notice_title, 'body', coalesce(notice_body, ''), 'tag', 'claude', 'url', './#notes'))
     where user_id = uid;
  end if;
  return n;
end $$;
revoke all on function public.put_notes(text, jsonb, text, text) from public;
grant execute on function public.put_notes(text, jsonb, text, text) to anon, authenticated;

-- PC から今のメモの一覧（中身なし）と合計サイズを確かめる
create or replace function public.list_notes(token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  select user_id into uid from public.export_tokens where token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex');
  if uid is null then raise exception 'invalid token'; end if;
  return jsonb_build_object(
    'notes', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'updated', meta->>'updated', 'bytes', octet_length(body)) order by id), '[]'::jsonb)
                from public.notes where user_id = uid),
    'bytes', (select coalesce(sum(octet_length(body) + octet_length(meta::text)), 0) from public.notes where user_id = uid));
end $$;
revoke all on function public.list_notes(text) from public;
grant execute on function public.list_notes(text) to anon, authenticated;
