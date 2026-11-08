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

-- 最初の 1 回分をすぐに作る
select public.make_backups();
