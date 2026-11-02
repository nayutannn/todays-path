-- send-push を 1 分ごとに呼び出す設定
-- Edge Function「send-push」を作った後に、SQL Editor に全文を貼り付けて「Run」を押してください（何度実行しても安全です）
-- 中の鍵は js/config.js と同じ公開用の anon キーです
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('send-push') where exists (select 1 from cron.job where jobname = 'send-push');
select cron.schedule('send-push', '* * * * *', $$
  select net.http_post(
    url := 'https://jqdwdnwamgvjigrxvndr.supabase.co/functions/v1/send-push',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxZHdkbndhbWd2amlncnh2bmRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzNzg5NjAsImV4cCI6MjEwODk1NDk2MH0.YNu8-xxRgRnMdOOmKj9_B8816t24boIQxgkFFCdiF0U"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
