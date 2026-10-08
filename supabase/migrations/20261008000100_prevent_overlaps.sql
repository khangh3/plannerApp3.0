-- The planner uses four-digit calendar dates. Check the entire supported date
-- range, rather than accepting conflicts beyond a short preview horizon.
alter table public.time_blocks add constraint planner_calendar_dates check (
  recurrence_start_date is null or (
    recurrence_start_date between date '0001-01-01' and date '9999-12-31'
    and (recurrence_until_date is null or recurrence_until_date <= date '9999-12-31')
  )
);

create function public.block_last_date(b public.time_blocks) returns date
language plpgsql stable set search_path = '' as $$
declare days integer[]; first_days integer[]; remaining bigint; week_number bigint;
begin
  if b.recurrence_until_date is not null then return b.recurrence_until_date; end if;
  if b.recurrence_count is null then return date '9999-12-31'; end if;
  select array_agg(weekday order by weekday),
    array_agg(weekday order by weekday) filter (where weekday >= extract(dow from b.recurrence_start_date))
  into days, first_days from public.time_block_weekdays where time_block_id = b.id;
  if b.recurrence_count <= coalesce(cardinality(first_days), 0) then
    return b.recurrence_start_date - extract(dow from b.recurrence_start_date)::integer
      + first_days[b.recurrence_count];
  end if;
  remaining := b.recurrence_count - coalesce(cardinality(first_days), 0) - 1;
  week_number := (remaining / cardinality(days) + 1) * b.recurrence_interval::bigint;
  -- Clamp before date arithmetic to avoid overflowing PostgreSQL's date type.
  if week_number * 7 > date '9999-12-31' - b.recurrence_start_date + 7 then
    return date '9999-12-31';
  end if;
  return least(date '9999-12-31',
    b.recurrence_start_date - extract(dow from b.recurrence_start_date)::integer
    + (week_number * 7)::integer + days[(remaining % cardinality(days))::integer + 1]);
end $$;

-- Enumerate scheduled starts directly by active weeks; no day-by-day scanning.
create function public.block_dates(b public.time_blocks, lo date, hi date)
returns table(occurrence_date date) language sql stable set search_path = '' as $$
  with bounds as (
    select b.recurrence_start_date - extract(dow from b.recurrence_start_date)::integer as anchor,
      greatest(lo, b.recurrence_start_date) as first_date,
      least(hi, public.block_last_date(b)) as last_date
  )
  select d.date from bounds x
  cross join lateral generate_series(
    greatest(0, (x.first_date - x.anchor) / 7 / b.recurrence_interval)::bigint,
    ((x.last_date - x.anchor) / 7 / b.recurrence_interval)::bigint
  ) as weeks(n)
  join public.time_block_weekdays w on w.time_block_id = b.id
  cross join lateral (select x.anchor + (weeks.n * b.recurrence_interval * 7)::integer + w.weekday as date) d
  where d.date between x.first_date and x.last_date
    and not exists (select 1 from public.time_block_exceptions e
      where e.time_block_id = b.id and e.occurrence_date = d.date);
$$;

create function public.blocks_overlap(a public.time_blocks, b public.time_blocks)
returns boolean language plpgsql stable set search_path = '' as $$
declare x public.time_blocks; y public.time_blocks; lo date; hi date; y_last date; y_anchor date;
begin
  if a.kind = 'oneOff' and b.kind = 'oneOff' then
    return a.start_at < b.end_at and a.end_at > b.start_at;
  end if;
  if a.kind = 'oneOff' or b.kind = 'oneOff' then
    if a.kind = 'recurring' then x := a; y := b; else x := b; y := a; end if;
    return exists (
      select 1 from public.block_dates(x,
        (y.start_at at time zone x.time_zone)::date - x.end_day_offset - 1,
        (y.end_at at time zone x.time_zone)::date) d
      where (d.occurrence_date + x.local_start_time) at time zone x.time_zone < y.end_at
        and ((d.occurrence_date + x.end_day_offset) + x.local_end_time) at time zone x.time_zone > y.start_at
    );
  end if;
  -- Iterate the schedule that ends sooner, and inspect only the few dates of
  -- the other schedule which could overlap each actual timestamp interval.
  if public.block_last_date(a) <= public.block_last_date(b) then x := a; y := b;
  else x := b; y := a; end if;
  lo := greatest(x.recurrence_start_date, y.recurrence_start_date - x.end_day_offset - 2);
  hi := least(public.block_last_date(x), public.block_last_date(y) + y.end_day_offset + 2);
  y_last := public.block_last_date(y);
  y_anchor := y.recurrence_start_date - extract(dow from y.recurrence_start_date)::integer;
  return exists (
    select 1 from public.block_dates(x, lo, hi) dx
    cross join lateral (select
      (dx.occurrence_date + x.local_start_time) at time zone x.time_zone as start_at,
      ((dx.occurrence_date + x.end_day_offset) + x.local_end_time) at time zone x.time_zone as end_at
    ) t
    cross join lateral generate_series(0,
      (t.end_at at time zone y.time_zone)::date - (t.start_at at time zone y.time_zone)::date + y.end_day_offset + 1) n
    cross join lateral (select (t.start_at at time zone y.time_zone)::date - y.end_day_offset - 1 + n as occurrence_date) dy
    join public.time_block_weekdays w on w.time_block_id = y.id and w.weekday = extract(dow from dy.occurrence_date)
    where dy.occurrence_date between y.recurrence_start_date and y_last
      and ((dy.occurrence_date - y_anchor) / 7) % y.recurrence_interval = 0
      and not exists (select 1 from public.time_block_exceptions e where e.time_block_id = y.id and e.occurrence_date = dy.occurrence_date)
      and (x.id <> y.id or dx.occurrence_date <> dy.occurrence_date)
      and (dy.occurrence_date + y.local_start_time) at time zone y.time_zone < t.end_at
      and ((dy.occurrence_date + y.end_day_offset) + y.local_end_time) at time zone y.time_zone > t.start_at
  );
end $$;

create function public.assert_block_no_overlap(p_id uuid) returns void
language plpgsql set search_path = '' as $$
declare candidate public.time_blocks; other public.time_blocks;
begin
  select * into candidate from public.time_blocks where id = p_id;
  if not found then return; end if;
  if candidate.kind = 'recurring'
    and (candidate.end_day_offset > 1 or (candidate.end_day_offset = 1 and candidate.local_end_time > candidate.local_start_time))
    and public.blocks_overlap(candidate, candidate) then
    raise exception 'This recurring schedule overlaps its own occurrences. Choose shorter blocks or fewer repeat dates.' using errcode = '23P01';
  end if;
  for other in select * from public.time_blocks where user_id = candidate.user_id and id <> p_id loop
    if public.blocks_overlap(candidate, other) then
      raise exception 'This time block overlaps "%". Choose a different time or repeat schedule.', other.title using errcode = '23P01';
    end if;
  end loop;
end $$;

-- Serializing all schedule mutations for an account closes the concurrent-save
-- race. Deferred validation sees detach/restore's final state, not temporary rows.
create function public.lock_planner_schedule() returns trigger
language plpgsql security definer set search_path = '' as $$
declare owner_id uuid;
begin
  if tg_table_name = 'time_blocks' then
    if tg_op = 'DELETE' then owner_id := old.user_id; else owner_id := new.user_id; end if;
  else
    select user_id into owner_id from public.time_blocks
      where id = case when tg_op = 'DELETE' then old.time_block_id else new.time_block_id end;
  end if;
  perform 1 from public.profiles where id = owner_id for update;
  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;
create trigger lock_schedule before insert or update or delete on public.time_blocks
  for each row execute function public.lock_planner_schedule();
create trigger lock_schedule before insert or update or delete on public.time_block_exceptions
  for each row execute function public.lock_planner_schedule();
create trigger lock_schedule before insert or update or delete on public.time_block_weekdays
  for each row execute function public.lock_planner_schedule();

create function public.validate_no_overlap() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'time_blocks' then perform public.assert_block_no_overlap(new.id);
  else perform public.assert_block_no_overlap(coalesce(new.time_block_id, old.time_block_id)); end if;
  return null;
end $$;
create constraint trigger no_overlap after insert or update on public.time_blocks
  deferrable initially deferred for each row execute function public.validate_no_overlap();
create constraint trigger no_overlap after insert or update or delete on public.time_block_exceptions
  deferrable initially deferred for each row execute function public.validate_no_overlap();
create constraint trigger no_overlap after insert or update or delete on public.time_block_weekdays
  deferrable initially deferred for each row execute function public.validate_no_overlap();

revoke all on function public.block_last_date(public.time_blocks),
  public.block_dates(public.time_blocks,date,date), public.blocks_overlap(public.time_blocks,public.time_blocks),
  public.assert_block_no_overlap(uuid), public.lock_planner_schedule(), public.validate_no_overlap()
  from public, anon, authenticated;

-- Acquire the account lock before the RPC takes any individual row locks.
alter function public.save_time_block(jsonb,uuid) rename to save_time_block_unchecked;
alter function public.skip_occurrence(uuid,date) rename to skip_occurrence_unchecked;
alter function public.detach_occurrence(uuid,date,jsonb) rename to detach_occurrence_unchecked;
alter function public.restore_occurrence(uuid) rename to restore_occurrence_unchecked;
alter function public.delete_time_block(uuid) rename to delete_time_block_unchecked;

create function public.save_time_block(p_draft jsonb, p_id uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.profiles where id = auth.uid() for update;
  return public.save_time_block_unchecked(p_draft, p_id);
end $$;
create function public.skip_occurrence(p_series_id uuid, p_occurrence_date date) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.profiles where id = auth.uid() for update;
  perform public.skip_occurrence_unchecked(p_series_id, p_occurrence_date);
end $$;
create function public.detach_occurrence(p_series_id uuid, p_occurrence_date date, p_draft jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.profiles where id = auth.uid() for update;
  return public.detach_occurrence_unchecked(p_series_id, p_occurrence_date, p_draft);
end $$;
create function public.restore_occurrence(p_replacement_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.profiles where id = auth.uid() for update;
  perform public.restore_occurrence_unchecked(p_replacement_id);
end $$;
create function public.delete_time_block(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.profiles where id = auth.uid() for update;
  perform public.delete_time_block_unchecked(p_id);
end $$;
revoke all on function public.save_time_block_unchecked(jsonb,uuid), public.skip_occurrence_unchecked(uuid,date),
  public.detach_occurrence_unchecked(uuid,date,jsonb), public.restore_occurrence_unchecked(uuid), public.delete_time_block_unchecked(uuid)
  from public, anon, authenticated;
revoke all on function public.save_time_block(jsonb,uuid), public.skip_occurrence(uuid,date),
  public.detach_occurrence(uuid,date,jsonb), public.restore_occurrence(uuid), public.delete_time_block(uuid) from public, anon;
grant execute on function public.save_time_block(jsonb,uuid), public.skip_occurrence(uuid,date),
  public.detach_occurrence(uuid,date,jsonb), public.restore_occurrence(uuid), public.delete_time_block(uuid) to authenticated;
