-- Today's Path 用のテーブル
-- Supabase の「SQL Editor」に全文を貼り付けて「Run」を押してください（何度実行しても安全です）

-- 予定・todo・タブ・確認待ち・設定を 1 行 1 件で保存する（中身は JSON）
create table if not exists public.items (
  user_id    uuid        not null default auth.uid() references auth.users on delete cascade,
  kind       text        not null check (kind in ('event', 'todo', 'tab', 'inbox', 'settings')),
  id         text        not null,
  data       jsonb       not null,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, id)
);
create index if not exists items_user_updated on public.items (user_id, updated_at);

-- iPhone / PC の通知の宛先（プッシュ通知用）
create table if not exists public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  sub        jsonb not null,
  device     text,
  created_at timestamptz not null default now()
);

-- これから鳴らす通知の予定表（アプリが計算して置き、サーバーが時刻になったら送る）
create table if not exists public.push_schedule (
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade,
  items      jsonb not null default '[]',
  sent_until timestamptz,
  updated_at timestamptz not null default now()
);

-- ログインした本人だけが使えるようにする（未ログインの anon には権限を与えない）
grant select, insert, update, delete on public.items to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select, insert, update, delete on public.push_schedule to authenticated;

-- 自分のデータだけ読み書きできるようにする
alter table public.items enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_schedule enable row level security;

drop policy if exists "own items" on public.items;
create policy "own items" on public.items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own subscriptions" on public.push_subscriptions;
create policy "own subscriptions" on public.push_subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own schedule" on public.push_schedule;
create policy "own schedule" on public.push_schedule
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- PC で変更したら iPhone に即反映させるためのリアルタイム配信
do $$
begin
  alter publication supabase_realtime add table public.items;
exception when duplicate_object then null;
end $$;
