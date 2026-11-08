-- 毎日のバックアップ（Supabase の中に 60 日分を残す）
-- SQL Editor に全文を貼り付けて「Run」を押してください（何度実行しても安全です）

create table if not exists public.backups (
  id         bigint generated always as identity primary key,
  user_id    uuid        not null references auth.users on delete cascade,
  kind       text        not null default 'auto',   -- auto: 毎日の自動 / manual: 手動・復元の直前
  count      int         not null,                  -- 予定・todo などの件数（消したものは数えない）
  items      jsonb       not null,                  -- items テーブルの行をそのまま（消したものも中身ごと）
  created_at timestamptz not null default now()
);
create index if not exists backups_user_created on public.backups (user_id, created_at desc);

alter table public.backups enable row level security;
grant select on public.backups to authenticated;
drop policy if exists "own backups" on public.backups;
create policy "own backups" on public.backups for select using (auth.uid() = user_id);

-- target を指定するとその人だけ、null なら全員分を保存する。60 日より古いものは消す
create or replace function public.make_backups(target uuid default null, backup_kind text default 'auto')
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.backups (user_id, kind, count, items)
  select user_id, backup_kind, count(*) filter (where not deleted),
         jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'data', data, 'deleted', deleted, 'updated_at', updated_at))
  from public.items
  where target is null or user_id = target
  group by user_id;
  get diagnostics n = row_count;
  delete from public.backups where created_at < now() - interval '60 days';
  return n;
end $$;

-- アプリの「今すぐバックアップ」用（ログインした本人の分だけ）
create or replace function public.backup_now()
returns int language sql security definer set search_path = public as $$
  select public.make_backups(auth.uid(), 'manual') where auth.uid() is not null;
$$;

revoke all on function public.make_backups(uuid, text) from public, anon, authenticated;
revoke all on function public.backup_now() from public, anon;
grant execute on function public.backup_now() to authenticated;

-- 毎日 4:00（日本時間）に全員分を保存
create extension if not exists pg_cron;
select cron.unschedule('daily-backup') where exists (select 1 from cron.job where jobname = 'daily-backup');
select cron.schedule('daily-backup', '0 19 * * *', $$ select public.make_backups() $$);

-- PC への週 1 回の自動バックアップ用。PC に置いた鍵の SHA-256 を登録しておき、その鍵でだけ中身を読み出せる
create table if not exists public.export_tokens (
  token_hash text primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  label      text,
  created_at timestamptz not null default now(),
  last_used  timestamptz
);
alter table public.export_tokens enable row level security;
grant select, insert, delete on public.export_tokens to authenticated;
drop policy if exists "own tokens" on public.export_tokens;
create policy "own tokens" on public.export_tokens
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 鍵が合えば、その人の予定・todo などを（消したものは除いて）返す
create or replace function public.export_items(token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  update public.export_tokens set last_used = now()
   where token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex')
  returning user_id into uid;
  if uid is null then raise exception 'invalid token'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'data', data, 'updated_at', updated_at)), '[]'::jsonb)
            from public.items where user_id = uid and not deleted);
end $$;
revoke all on function public.export_items(text) from public;
grant execute on function public.export_items(text) to anon, authenticated;

-- 最初の 1 回分をすぐに作る
select public.make_backups();
