// 1 分ごとに呼ばれ、時刻になった通知を各端末へプッシュ送信する Edge Function（名前: send-push）
// 必要な Secrets: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT（SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY は最初から入っている）
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') || 'mailto:noreply@example.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);

// 呼び出しが一度抜けても取りこぼさないよう、前回送った時刻から今までの分を送る（ただし 30 分より古いものは送らない）
const MAX_LATE = 30 * 60000;

Deno.serve(async () => {
  const now = new Date();
  const { data: rows, error } = await sb.from('push_schedule').select('user_id, items, sent_until');
  if (error) return new Response(error.message, { status: 500 });

  let sent = 0;
  for (const row of rows ?? []) {
    const from = Math.max(row.sent_until ? Date.parse(row.sent_until) : 0, now.getTime() - MAX_LATE);
    const due = (row.items ?? []).filter((n: { at: string }) => {
      const t = Date.parse(n.at);
      return t > from && t <= now.getTime();
    });
    if (due.length) {
      const { data: subs } = await sb.from('push_subscriptions').select('endpoint, sub').eq('user_id', row.user_id);
      for (const s of subs ?? []) {
        for (const n of due) {
          try {
            await webpush.sendNotification(s.sub, JSON.stringify({ title: n.title, body: n.body, tag: n.tag, url: n.url }), { TTL: 3600, urgency: 'high' });
            sent++;
          } catch (e) {
            // 端末側で通知をやめた・アプリを消した宛先は削除する
            const code = (e as { statusCode?: number }).statusCode;
            if (code === 404 || code === 410) { await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint); break; }
            console.error('push failed', code, (e as Error).message);
          }
        }
      }
    }
    await sb.from('push_schedule').update({ sent_until: now.toISOString() }).eq('user_id', row.user_id);
  }
  return Response.json({ sent });
});
