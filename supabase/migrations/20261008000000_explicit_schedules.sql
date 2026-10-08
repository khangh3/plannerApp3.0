-- Preserve existing schedules while replacing the old overloaded timestamp model.
drop trigger validate_schedule on public.time_blocks;
drop trigger validate_schedule on public.time_block_weekdays;
drop trigger validate_schedule on public.time_block_exceptions;
drop function public.validate_block_schedule();
drop function public.exception_is_valid(uuid,timestamptz);
drop function public.save_time_block(uuid,text,integer,text,timestamptz,timestamptz,text,timestamptz,timestamptz,text,smallint[]);
alter table public.time_blocks add column kind text, add column start_at timestamptz, add column end_at timestamptz,
 add column local_start_time time, add column local_end_time time, add column end_day_offset integer,
 add column recurrence_start_date date, add column recurrence_until_date date, add column recurrence_count integer,
 add column recurrence_interval integer, add column origin_series_id uuid references public.time_blocks(id) on delete set null,
 add column origin_occurrence_date date;
update public.time_blocks set kind=case when recurring_start_date is null then 'oneOff' else 'recurring' end,
 start_at=case when recurring_start_date is null then start_time end, end_at=case when recurring_start_date is null then end_time end,
 local_start_time=case when recurring_start_date is not null then (start_time at time zone time_zone)::time end,
 local_end_time=case when recurring_start_date is not null then (end_time at time zone time_zone)::time end,
 end_day_offset=case when recurring_start_date is not null then (end_time at time zone time_zone)::date-(start_time at time zone time_zone)::date end,
 recurrence_start_date=(recurring_start_date at time zone time_zone)::date,
 recurrence_until_date=(recurring_end_date at time zone time_zone)::date-1,
 recurrence_interval=case when recurring_start_date is not null then 1 end;
alter table public.time_block_exceptions add column occurrence_date date, add column kind text not null default 'skipped', add column replacement_block_id uuid unique references public.time_blocks(id) on delete set null;
update public.time_block_exceptions e set occurrence_date=(e.date at time zone b.time_zone)::date from public.time_blocks b where b.id=e.time_block_id;
alter table public.time_block_exceptions drop column date, alter column occurrence_date set not null, add unique(time_block_id,occurrence_date), add check(kind in ('skipped','replaced'));
alter table public.time_blocks drop column start_time, drop column end_time, drop column recurring_start_date, drop column recurring_end_date, alter column kind set not null,
 add check(kind in ('oneOff','recurring')),
 add check ((kind='oneOff' and start_at is not null and end_at>start_at and local_start_time is null and local_end_time is null and end_day_offset is null and recurrence_start_date is null and recurrence_until_date is null and recurrence_count is null and recurrence_interval is null)
 or (kind='recurring' and start_at is null and end_at is null and local_start_time is not null and local_end_time is not null and end_day_offset>=0 and (end_day_offset>0 or local_end_time>local_start_time) and recurrence_start_date is not null and recurrence_interval>0 and (recurrence_until_date is null or recurrence_until_date>=recurrence_start_date) and (recurrence_count is null or recurrence_count>0) and not(recurrence_until_date is not null and recurrence_count is not null) and origin_series_id is null));
-- All schedule mutations go through ownership-checked, transactional RPCs.
revoke insert,update,delete on public.time_blocks,public.time_block_weekdays,public.time_block_exceptions from authenticated;
create function public.scheduled_date(p_id uuid,p_date date) returns boolean language plpgsql stable set search_path='' as $$
declare b public.time_blocks; n bigint; anchor date; weeks integer; first_count integer; days_count integer; partial_count integer;
begin
 select * into b from public.time_blocks where id=p_id;
 if not found or b.kind<>'recurring' or p_date<b.recurrence_start_date or (b.recurrence_until_date is not null and p_date>b.recurrence_until_date) then return false; end if;
 anchor:=b.recurrence_start_date-extract(dow from b.recurrence_start_date)::integer;
 weeks:=(p_date-anchor)/7;
 if weeks%b.recurrence_interval<>0 or not exists(select 1 from public.time_block_weekdays where time_block_id=p_id and weekday=extract(dow from p_date)) then return false; end if;
 if b.recurrence_count is null then return true; end if;
 select count(*),count(*) filter(where weekday>=extract(dow from b.recurrence_start_date)),count(*) filter(where weekday<=extract(dow from p_date)) into days_count,first_count,partial_count from public.time_block_weekdays where time_block_id=p_id;
 if weeks=0 then n:=partial_count-(days_count-first_count); else n:=first_count+((weeks/b.recurrence_interval)-1)::bigint*days_count+partial_count; end if;
 return n<=b.recurrence_count;
end $$;
create function public.save_time_block(p_draft jsonb,p_id uuid default null) returns uuid language plpgsql security definer set search_path='' as $$
declare b public.time_blocks; bid uuid:=coalesce(p_id,gen_random_uuid()); k text:=p_draft->>'kind'; d integer; days integer[];
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if p_id is not null then
 select * into b from public.time_blocks where id=p_id and user_id=auth.uid() for update;
 if not found then raise exception 'Time block not found'; end if;
 if b.origin_series_id is not null and k<>'oneOff' then raise exception 'Detached blocks must remain one-off'; end if;
 if b.kind='recurring' and k<>'recurring' and exists(select 1 from public.time_block_exceptions where time_block_id=p_id and kind='replaced') then raise exception 'Restore or delete detached occurrences before changing series kind'; end if;
 end if;
 if k='recurring' then
 if p_draft#>>'{recurrence,frequency}' is distinct from 'weekly' or coalesce(p_draft#>>'{recurrence,end,kind}','') not in ('never','until','count') then raise exception 'Invalid recurrence'; end if;
 if (p_draft#>>'{recurrence,end,kind}'='until' and p_draft#>>'{recurrence,end,date}' is null) or (p_draft#>>'{recurrence,end,kind}'='count' and p_draft#>>'{recurrence,end,count}' is null) then raise exception 'Recurrence end value required'; end if;
 if p_draft->>'startTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or p_draft->>'endTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Use HH:mm wall-clock times'; end if;
 select array_agg(value::integer) into days from jsonb_array_elements_text(p_draft#>'{recurrence,weekdays}');
 if coalesce(cardinality(days),0)=0 or cardinality(days)<>(select count(distinct x) from unnest(days) x) or exists(select 1 from unnest(days) x where x is null or x<0 or x>6) then raise exception 'Invalid weekdays'; end if;
 end if;
 insert into public.time_blocks(id,user_id,title,category_id,availability,description,time_zone,kind,start_at,end_at,local_start_time,local_end_time,end_day_offset,recurrence_start_date,recurrence_until_date,recurrence_count,recurrence_interval)
 values(bid,auth.uid(),trim(p_draft->>'title'),(p_draft->>'categoryId')::integer,p_draft->>'availability',nullif(trim(p_draft->>'description'),''),p_draft->>'timezone',k,
 case when k='oneOff' then (p_draft->>'startAt')::timestamptz end,case when k='oneOff' then (p_draft->>'endAt')::timestamptz end,
 case when k='recurring' then (p_draft->>'startTime')::time end,case when k='recurring' then (p_draft->>'endTime')::time end,case when k='recurring' then (p_draft->>'endDayOffset')::integer end,
 case when k='recurring' then (p_draft#>>'{recurrence,startDate}')::date end,
 case when k='recurring' and p_draft#>>'{recurrence,end,kind}'='until' then (p_draft#>>'{recurrence,end,date}')::date end,
 case when k='recurring' and p_draft#>>'{recurrence,end,kind}'='count' then (p_draft#>>'{recurrence,end,count}')::integer end,
 case when k='recurring' then (p_draft#>>'{recurrence,interval}')::integer end)
 on conflict(id) do update set title=excluded.title,category_id=excluded.category_id,availability=excluded.availability,description=excluded.description,time_zone=excluded.time_zone,kind=excluded.kind,start_at=excluded.start_at,end_at=excluded.end_at,local_start_time=excluded.local_start_time,local_end_time=excluded.local_end_time,end_day_offset=excluded.end_day_offset,recurrence_start_date=excluded.recurrence_start_date,recurrence_until_date=excluded.recurrence_until_date,recurrence_count=excluded.recurrence_count,recurrence_interval=excluded.recurrence_interval;
 delete from public.time_block_weekdays where time_block_id=bid;
 foreach d in array coalesce(days,'{}'::integer[]) loop insert into public.time_block_weekdays values(bid,d); end loop;
 delete from public.time_block_exceptions where time_block_id=bid and kind='skipped' and not public.scheduled_date(bid,occurrence_date);
 return bid;
end $$;
create function public.skip_occurrence(p_series_id uuid,p_occurrence_date date) returns void language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.time_blocks where id=p_series_id and user_id=auth.uid() for update;
 if not found or not public.scheduled_date(p_series_id,p_occurrence_date) then raise exception 'Scheduled occurrence not found'; end if;
 insert into public.time_block_exceptions(time_block_id,occurrence_date) values(p_series_id,p_occurrence_date);
end $$;
create function public.detach_occurrence(p_series_id uuid,p_occurrence_date date,p_draft jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare bid uuid;
begin
 if p_draft->>'kind' is distinct from 'oneOff' then raise exception 'Replacement must be one-off'; end if;
 perform public.skip_occurrence(p_series_id,p_occurrence_date);
 bid:=public.save_time_block(p_draft);
 update public.time_blocks set origin_series_id=p_series_id,origin_occurrence_date=p_occurrence_date where id=bid;
 update public.time_block_exceptions set kind='replaced',replacement_block_id=bid where time_block_id=p_series_id and occurrence_date=p_occurrence_date;
 return bid;
end $$;
create function public.restore_occurrence(p_replacement_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare b public.time_blocks; sid uuid;
begin
 select origin_series_id into sid from public.time_blocks where id=p_replacement_id and user_id=auth.uid();
 if sid is null then raise exception 'Original series no longer exists'; end if;
 -- Always lock the series first, matching detach/delete and preventing races.
 perform 1 from public.time_blocks where id=sid and user_id=auth.uid() for update;
 select * into b from public.time_blocks where id=p_replacement_id and user_id=auth.uid() for update;
 if not found or b.origin_series_id is distinct from sid or not public.scheduled_date(sid,b.origin_occurrence_date) then raise exception 'Original date is no longer scheduled'; end if;
 delete from public.time_block_exceptions where time_block_id=sid and occurrence_date=b.origin_occurrence_date and replacement_block_id=p_replacement_id;
 if not found then raise exception 'Replacement link no longer exists'; end if;
 delete from public.time_blocks where id=p_replacement_id;
end $$;
create function public.delete_time_block(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare sid uuid;
begin
 select origin_series_id into sid from public.time_blocks where id=p_id and user_id=auth.uid();
 if sid is not null then perform 1 from public.time_blocks where id=sid and user_id=auth.uid() for update; end if;
 perform 1 from public.time_blocks where id=p_id and user_id=auth.uid() for update;
 if not found then raise exception 'Time block not found'; end if;
 update public.time_block_exceptions set kind='skipped',replacement_block_id=null where replacement_block_id=p_id;
 update public.time_blocks set origin_series_id=null,origin_occurrence_date=null where origin_series_id=p_id;
 delete from public.time_blocks where id=p_id;
end $$;
revoke all on function public.scheduled_date(uuid,date),public.save_time_block(jsonb,uuid),public.skip_occurrence(uuid,date),public.detach_occurrence(uuid,date,jsonb),public.restore_occurrence(uuid),public.delete_time_block(uuid) from public,anon;
grant execute on function public.save_time_block(jsonb,uuid),public.skip_occurrence(uuid,date),public.detach_occurrence(uuid,date,jsonb),public.restore_occurrence(uuid),public.delete_time_block(uuid) to authenticated;
-- CHECK expressions must explicitly reject missing JSON fields (SQL NULL is not false).
alter table public.time_blocks add check(kind<>'oneOff' or end_at is not null),
 add check(kind<>'recurring' or (end_day_offset is not null and recurrence_interval is not null));

