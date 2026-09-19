-- Restaurant Diary: shared diary schema.
-- Paste this whole file into the Supabase project: SQL Editor -> New query -> Run.
-- It is safe to run again, and it doesn't touch the cocktail app's tables in the same project.
--
-- Nobody types an email or password. Each device gets an anonymous identity
-- (Authentication -> Sign In / Providers -> "Allow anonymous sign-ins" must be on),
-- and a diary's code is what lets another person or device in.

create extension if not exists pgcrypto;

-- A diary is one shared collection. You and the people you invite are its members.
create table if not exists public.diaries (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our diary',
  invite_code text not null unique default upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8)),
  -- The Google Maps key everyone in the diary uses. Only members can read it.
  google_key text not null default '',
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.diary_members (
  diary_id uuid not null references public.diaries (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (diary_id, user_id)
);

-- One row per restaurant; `data` is the object the app uses. Deletions stay as
-- tombstones so they reach the other devices.
create table if not exists public.diary_restaurants (
  diary_id uuid not null references public.diaries (id) on delete cascade,
  item_id text not null check (item_id ~ '^[0-9a-f]{32}$'),
  data jsonb,
  deleted boolean not null default false,
  -- When the edit was made on the device: the newer edit wins.
  updated_at timestamptz not null default now(),
  -- When the server stored it: devices fetch everything changed since they last looked.
  changed_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  primary key (diary_id, item_id)
);

create index if not exists diary_restaurants_changed_idx on public.diary_restaurants (diary_id, changed_at);

-- Google requests counted per month, so the diary stops before Google's free allowance.
create table if not exists public.diary_usage (
  diary_id uuid not null references public.diaries (id) on delete cascade,
  month text not null,
  kind text not null check (kind in ('details', 'autocomplete', 'map_load')),
  used integer not null default 0,
  primary key (diary_id, month, kind)
);

alter table public.diaries enable row level security;
alter table public.diary_members enable row level security;
alter table public.diary_restaurants enable row level security;
alter table public.diary_usage enable row level security;

-- An edit made offline and sent late must not overwrite a newer one.
create or replace function public.diary_restaurants_stamp()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;
  end if;
  new.changed_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists diary_restaurants_stamp on public.diary_restaurants;
create trigger diary_restaurants_stamp before insert or update on public.diary_restaurants
  for each row execute function public.diary_restaurants_stamp();

-- Membership test. Security definer, so the policies below don't recurse through RLS.
create or replace function public.is_diary_member(target uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.diary_members m where m.diary_id = target and m.user_id = auth.uid());
$$;

drop policy if exists diaries_select on public.diaries;
-- created_by: the creator reads the new diary back before their membership row exists
create policy diaries_select on public.diaries for select to authenticated
  using (created_by = auth.uid() or public.is_diary_member(id));

drop policy if exists diaries_insert on public.diaries;
create policy diaries_insert on public.diaries for insert to authenticated with check (created_by = auth.uid());

drop policy if exists diaries_update on public.diaries;
create policy diaries_update on public.diaries for update to authenticated
  using (public.is_diary_member(id)) with check (public.is_diary_member(id));

drop policy if exists diary_members_select on public.diary_members;
create policy diary_members_select on public.diary_members for select to authenticated
  using (public.is_diary_member(diary_id));

drop policy if exists diary_members_insert_self on public.diary_members;
create policy diary_members_insert_self on public.diary_members for insert to authenticated
  with check (user_id = auth.uid() and exists (
    select 1 from public.diaries d where d.id = diary_id and d.created_by = auth.uid()));

drop policy if exists diary_members_delete_self on public.diary_members;
create policy diary_members_delete_self on public.diary_members for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists diary_restaurants_select on public.diary_restaurants;
create policy diary_restaurants_select on public.diary_restaurants for select to authenticated
  using (public.is_diary_member(diary_id));

drop policy if exists diary_restaurants_insert on public.diary_restaurants;
create policy diary_restaurants_insert on public.diary_restaurants for insert to authenticated
  with check (public.is_diary_member(diary_id));

drop policy if exists diary_restaurants_update on public.diary_restaurants;
create policy diary_restaurants_update on public.diary_restaurants for update to authenticated
  using (public.is_diary_member(diary_id)) with check (public.is_diary_member(diary_id));

-- Usage rows are read by members and written only through the functions below.
drop policy if exists diary_usage_select on public.diary_usage;
create policy diary_usage_select on public.diary_usage for select to authenticated
  using (public.is_diary_member(diary_id));

-- Joining by code: the joiner can't read other people's diaries, so this runs as definer.
create or replace function public.join_diary(code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare target uuid;
begin
  select id into target from public.diaries where invite_code = upper(trim(code));
  if target is null then raise exception 'invalid invite code' using errcode = 'P0002'; end if;
  insert into public.diary_members (diary_id, user_id) values (target, auth.uid()) on conflict do nothing;
  return target;
end;
$$;

-- Google bills by calendar month in Pacific time. A fixed UTC-8 never starts the
-- new month before Google does, so the counters never reset early.
create or replace function public.google_month()
returns text language sql stable as $$
  select to_char((now() at time zone 'UTC') - interval '8 hours', 'YYYY-MM');
$$;

create or replace function public.google_limit(what text)
returns integer language sql immutable as $$
  -- 90% of Google's free monthly usage for each kind of request
  select case what when 'details' then 900 when 'autocomplete' then 9000 when 'map_load' then 9000 end;
$$;

create or replace function public.google_usage(target uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare counts jsonb;
begin
  if not public.is_diary_member(target) then raise exception 'not a member of this diary' using errcode = '42501'; end if;
  select coalesce(jsonb_object_agg(kind, used), '{}'::jsonb) into counts
    from public.diary_usage where diary_id = target and month = public.google_month();
  return jsonb_build_object('month', public.google_month(), 'counts', counts);
end;
$$;

-- Count one Google request, or refuse without counting once the month's limit is reached.
-- The app only calls Google after this says ok.
create or replace function public.reserve_google(target uuid, what text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cap integer := public.google_limit(what); counted integer;
begin
  if not public.is_diary_member(target) then raise exception 'not a member of this diary' using errcode = '42501'; end if;
  if cap is null then raise exception 'unknown request kind' using errcode = '22023'; end if;
  insert into public.diary_usage as u (diary_id, month, kind, used)
    values (target, public.google_month(), what, 1)
    on conflict (diary_id, month, kind) do update set used = u.used + 1 where u.used < cap
    returning used into counted;
  return jsonb_build_object('ok', counted is not null, 'usage', public.google_usage(target));
end;
$$;

-- Give back a request Google refused, so it can't have been billed.
create or replace function public.refund_google(target uuid, what text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_diary_member(target) then raise exception 'not a member of this diary' using errcode = '42501'; end if;
  update public.diary_usage set used = greatest(0, used - 1)
    where diary_id = target and month = public.google_month() and kind = what;
  return public.google_usage(target);
end;
$$;

-- Carry over what was already used this month (from the old local app).
create or replace function public.add_google_usage(target uuid, what text, amount integer)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_diary_member(target) then raise exception 'not a member of this diary' using errcode = '42501'; end if;
  if public.google_limit(what) is null or amount < 0 or amount > 10000 then
    raise exception 'invalid usage' using errcode = '22023';
  end if;
  insert into public.diary_usage as u (diary_id, month, kind, used)
    values (target, public.google_month(), what, amount)
    on conflict (diary_id, month, kind) do update set used = u.used + amount;
  return public.google_usage(target);
end;
$$;

grant execute on function public.join_diary(text) to authenticated;
grant execute on function public.google_usage(uuid) to authenticated;
grant execute on function public.reserve_google(uuid, text) to authenticated;
grant execute on function public.refund_google(uuid, text) to authenticated;
grant execute on function public.add_google_usage(uuid, text, integer) to authenticated;

-- Live updates on every device in the diary
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                 and schemaname = 'public' and tablename = 'diary_restaurants') then
    alter publication supabase_realtime add table public.diary_restaurants;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                 and schemaname = 'public' and tablename = 'diaries') then
    alter publication supabase_realtime add table public.diaries;
  end if;
end;
$$;

-- Photos: one private bucket; a diary's folder is readable and writable by its members.
insert into storage.buckets (id, name, public) values ('diary-photos', 'diary-photos', false)
  on conflict (id) do nothing;

drop policy if exists diary_photos_read on storage.objects;
create policy diary_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'diary-photos' and public.is_diary_member(((storage.foldername(name))[1])::uuid));

drop policy if exists diary_photos_write on storage.objects;
create policy diary_photos_write on storage.objects for insert to authenticated
  with check (bucket_id = 'diary-photos' and public.is_diary_member(((storage.foldername(name))[1])::uuid));

drop policy if exists diary_photos_update on storage.objects;
create policy diary_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'diary-photos' and public.is_diary_member(((storage.foldername(name))[1])::uuid));

drop policy if exists diary_photos_delete on storage.objects;
create policy diary_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'diary-photos' and public.is_diary_member(((storage.foldername(name))[1])::uuid));
