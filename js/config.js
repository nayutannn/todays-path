// Supabase の接続先（anon キーはアプリに埋め込む前提の公開用キー。service_role キーは絶対にここへ書かない）
export const SUPABASE_URL = 'https://jqdwdnwamgvjigrxvndr.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxZHdkbndhbWd2amlncnh2bmRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzNzg5NjAsImV4cCI6MjEwODk1NDk2MH0.YNu8-xxRgRnMdOOmKj9_B8816t24boIQxgkFFCdiF0U';

// プッシュ通知の公開鍵（対になる秘密鍵は Supabase の Edge Function の Secrets にだけ置く）
export const VAPID_PUBLIC_KEY = 'BConaXTJbWp4CnYrgMLdrHe4pYJu2pQIoix7BhmWl7t_R0CqWyI4vjllsmmvZaa2egpwcG9zbTspDw-tV7X6wOQ';
