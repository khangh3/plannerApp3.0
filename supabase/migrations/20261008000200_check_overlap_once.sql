-- Weekdays are only replaced inside save_time_block, which always writes the
-- parent block. Validate that final parent once instead of repeating the full
-- recurrence comparison for every individual weekday/exception row.
drop trigger if exists no_overlap on public.time_block_weekdays;
drop trigger if exists no_overlap on public.time_block_exceptions;

create or replace function public.assert_block_no_overlap(p_id uuid) returns void
language plpgsql set search_path = '' as $$
declare candidate public.time_blocks; other public.time_blocks; minimum_gap bigint;
begin
  select * into candidate from public.time_blocks where id = p_id;
  if not found then return; end if;
  if candidate.kind = 'recurring' and candidate.end_day_offset > 0
    and coalesce(candidate.recurrence_count, 2) > 1 then
    select min(case when b.weekday > a.weekday then b.weekday - a.weekday
      else candidate.recurrence_interval::bigint * 7 + b.weekday - a.weekday end)
      into minimum_gap from public.time_block_weekdays a cross join public.time_block_weekdays b
      where a.time_block_id = candidate.id and b.time_block_id = candidate.id;
    -- Include the extra local day for DST gaps; an end clock that precedes the
    -- next start clock can still overlap when a nonexistent time is shifted.
    if minimum_gap <= candidate.end_day_offset::bigint + 1
      and public.blocks_overlap(candidate, candidate) then
      raise exception 'This recurring schedule overlaps its own occurrences. Choose shorter blocks or fewer repeat dates.' using errcode = '23P01';
    end if;
  end if;
  for other in select * from public.time_blocks where user_id = candidate.user_id and id <> p_id loop
    if public.blocks_overlap(candidate, other) then
      raise exception 'This time block overlaps "%". Choose a different time or repeat schedule.', other.title using errcode = '23P01';
    end if;
  end loop;
end $$;

-- Restore is the only RPC that adds occupied time without inserting/updating a
-- parent block. Check the restored series after both atomic changes are done.
create or replace function public.restore_occurrence(p_replacement_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare series_id uuid;
begin
  perform 1 from public.profiles where id = auth.uid() for update;
  select origin_series_id into series_id from public.time_blocks
    where id = p_replacement_id and user_id = auth.uid();
  perform public.restore_occurrence_unchecked(p_replacement_id);
  perform public.assert_block_no_overlap(series_id);
end $$;
