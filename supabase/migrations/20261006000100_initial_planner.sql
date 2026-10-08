create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  time_zone text not null default 'UTC',
  created_at timestamptz not null default now()
);
create table public.categories (
  id integer generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  color text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  unique (id, user_id)
);
create table public.time_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  category_id integer not null,
  availability text not null check (availability in ('busy', 'flexible')),
  start_time timestamptz not null,
  end_time timestamptz not null,
  description text,
  recurring_start_date timestamptz,
  recurring_end_date timestamptz,
  time_zone text not null,
  foreign key (category_id, user_id) references public.categories(id, user_id),
  check (end_time > start_time),
  check (recurring_end_date is null or (recurring_start_date is not null and recurring_end_date > recurring_start_date))
);
create table public.time_block_weekdays (
  time_block_id uuid not null references public.time_blocks(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  primary key (time_block_id, weekday)
);
create table public.time_block_exceptions (
  id integer generated always as identity primary key,
  time_block_id uuid not null references public.time_blocks(id) on delete cascade,
  date timestamptz not null,
  unique (time_block_id, date)
);
create index categories_user_id_idx on public.categories(user_id);
create index time_blocks_user_id_idx on public.time_blocks(user_id);

alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.time_blocks enable row level security;
alter table public.time_block_weekdays enable row level security;
alter table public.time_block_exceptions enable row level security;
create policy owner on public.profiles for all to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy owner on public.categories for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy owner on public.time_blocks for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy owner on public.time_block_weekdays for all to authenticated
  using (exists (select 1 from public.time_blocks b where b.id = time_block_id and b.user_id = (select auth.uid())))
  with check (exists (select 1 from public.time_blocks b where b.id = time_block_id and b.user_id = (select auth.uid())));
create policy owner on public.time_block_exceptions for all to authenticated
  using (exists (select 1 from public.time_blocks b where b.id = time_block_id and b.user_id = (select auth.uid())))
  with check (exists (select 1 from public.time_blocks b where b.id = time_block_id and b.user_id = (select auth.uid())));
revoke all on public.profiles, public.categories, public.time_blocks, public.time_block_weekdays, public.time_block_exceptions from anon;
grant select, insert, update, delete on public.profiles, public.categories, public.time_blocks, public.time_block_weekdays, public.time_block_exceptions to authenticated;
grant usage, select on sequence public.categories_id_seq, public.time_block_exceptions_id_seq to authenticated;

create function public.validate_time_zone() returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.time_zone) then
    raise exception 'Unknown time zone: %', new.time_zone;
  end if;
  return new;
end;
$$;
create trigger profile_time_zone before insert or update on public.profiles for each row execute function public.validate_time_zone();
create trigger block_time_zone before insert or update on public.time_blocks for each row execute function public.validate_time_zone();

create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name, time_zone) values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''), coalesce((select name from pg_catalog.pg_timezone_names where name = new.raw_user_meta_data ->> 'time_zone' limit 1), 'UTC'));
  insert into public.categories(user_id, name, color) values
    (new.id, 'Work', '#6366f1'), (new.id, 'Personal', '#14b8a6'), (new.id, 'Focus', '#f59e0b');
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Dates represent midnight in the block's named zone, including across DST changes.
create function public.exception_is_valid(p_block_id uuid, p_date timestamptz) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.time_blocks b
    where b.id = p_block_id and b.recurring_start_date is not null
      and p_date >= b.recurring_start_date
      and (b.recurring_end_date is null or p_date < b.recurring_end_date)
      and (p_date at time zone b.time_zone)::time = time '00:00:00'
      and exists (select 1 from public.time_block_weekdays w where w.time_block_id = b.id
        and w.weekday = extract(dow from p_date at time zone b.time_zone))
  );
$$;

-- Deferred checks permit the RPC to replace all weekdays atomically.
create function public.validate_block_schedule() returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  block_id uuid;
  b public.time_blocks;
  has_days boolean;
begin
  if tg_table_name = 'time_blocks' then block_id := coalesce(new.id, old.id);
  else block_id := coalesce(new.time_block_id, old.time_block_id); end if;
  select * into b from public.time_blocks where id = block_id;
  if not found then return null; end if;
  select exists (select 1 from public.time_block_weekdays where time_block_id = block_id) into has_days;
  if (b.recurring_start_date is not null) <> has_days then
    raise exception 'Recurring blocks require weekdays; one-off blocks must have none';
  end if;
  if b.recurring_start_date is not null and (
      (b.recurring_start_date at time zone b.time_zone)::time <> time '00:00:00'
      or (b.recurring_end_date is not null and (b.recurring_end_date at time zone b.time_zone)::time <> time '00:00:00')) then
    raise exception 'Recurrence boundaries must be local midnight in the block time zone';
  end if;
  if exists (select 1 from public.time_block_exceptions e where e.time_block_id = block_id
      and not public.exception_is_valid(block_id, e.date)) then
    raise exception 'Exception must be a scheduled recurring date at local midnight';
  end if;
  return null;
end;
$$;
create constraint trigger validate_schedule after insert or update on public.time_blocks deferrable initially deferred for each row execute function public.validate_block_schedule();
create constraint trigger validate_schedule after insert or update or delete on public.time_block_weekdays deferrable initially deferred for each row execute function public.validate_block_schedule();
create constraint trigger validate_schedule after insert or update on public.time_block_exceptions deferrable initially deferred for each row execute function public.validate_block_schedule();

create function public.save_time_block(
  p_id uuid, p_title text, p_category_id integer, p_availability text,
  p_start_time timestamptz, p_end_time timestamptz, p_description text,
  p_recurring_start_date timestamptz, p_recurring_end_date timestamptz,
  p_time_zone text, p_weekdays smallint[]
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare block_id uuid; current_user_id uuid := auth.uid();
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if p_weekdays is null then p_weekdays := '{}'::smallint[]; end if;
  if exists (select 1 from unnest(p_weekdays) d where d is null or d < 0 or d > 6)
    or cardinality(p_weekdays) <> (select count(distinct d) from unnest(p_weekdays) d) then
    raise exception 'Weekdays must be distinct integers from 0 to 6';
  end if;
  if p_id is null then
    insert into public.time_blocks(user_id, title, category_id, availability, start_time, end_time, description, recurring_start_date, recurring_end_date, time_zone)
    values (current_user_id, p_title, p_category_id, p_availability, p_start_time, p_end_time, p_description, p_recurring_start_date, p_recurring_end_date, p_time_zone)
    returning id into block_id;
  else
    update public.time_blocks set title = p_title, category_id = p_category_id, availability = p_availability,
      start_time = p_start_time, end_time = p_end_time, description = p_description,
      recurring_start_date = p_recurring_start_date, recurring_end_date = p_recurring_end_date, time_zone = p_time_zone
    where id = p_id and user_id = current_user_id returning id into block_id;
    if block_id is null then raise exception 'Time block not found'; end if;
  end if;
  delete from public.time_block_weekdays where time_block_id = block_id;
  insert into public.time_block_weekdays(time_block_id, weekday) select block_id, d from unnest(p_weekdays) d;
  -- Keep only exceptions that remain meaningful after a series edit.
  delete from public.time_block_exceptions e where e.time_block_id = block_id and not public.exception_is_valid(block_id, e.date);
  return block_id;
end;
$$;
revoke all on function public.save_time_block(uuid,text,integer,text,timestamptz,timestamptz,text,timestamptz,timestamptz,text,smallint[]) from public, anon;
grant execute on function public.save_time_block(uuid,text,integer,text,timestamptz,timestamptz,text,timestamptz,timestamptz,text,smallint[]) to authenticated;
revoke all on function public.exception_is_valid(uuid,timestamptz) from public, anon;
grant execute on function public.exception_is_valid(uuid,timestamptz) to authenticated;
revoke all on function public.validate_time_zone(), public.validate_block_schedule() from public, anon;

-- Child rows belong to one series for their entire lifetime. Moving them would
-- otherwise require validating both old and new schedules at transaction end.
create function public.prevent_child_reparent() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.time_block_id <> old.time_block_id then raise exception 'Cannot move a child row to another time block'; end if;
  return new;
end;
$$;
create trigger prevent_reparent before update on public.time_block_weekdays for each row execute function public.prevent_child_reparent();
create trigger prevent_reparent before update on public.time_block_exceptions for each row execute function public.prevent_child_reparent();
revoke all on function public.prevent_child_reparent() from public, anon;

