import type { Dayjs } from 'dayjs';
import { dayjs } from './time';
import { requireSupabase } from './supabase';
import type { Availability, Category, TimeBlock, TimeBlockDraft, TimeBlockException } from '../type';

export type PlannerBlock = TimeBlock & { exceptions: TimeBlockException[] };

type Row = {
  id: string; user_id: string; title: string; category_id: number; availability: Availability;
  start_time: string; end_time: string; description: string | null;
  recurring_start_date: string | null; recurring_end_date: string | null; time_zone: string;
  time_block_weekdays: { weekday: number }[];
  time_block_exceptions: { id: number; date: string }[];
};
const SELECT = '*, time_block_weekdays(weekday), time_block_exceptions(id, date)';

const check = <T>({ data, error }: { data: T; error: { message: string } | null }) => {
  if (error) throw new Error(error.message);
  return data;
};

const fromRow = (r: Row): PlannerBlock => ({
  id: r.id, userId: r.user_id, title: r.title, categoryId: r.category_id, availability: r.availability,
  startTime: dayjs(r.start_time), endTime: dayjs(r.end_time), description: r.description ?? undefined,
  recurringStartDate: r.recurring_start_date ? dayjs(r.recurring_start_date) : undefined,
  recurringEndDate: r.recurring_end_date ? dayjs(r.recurring_end_date) : undefined,
  timezone: r.time_zone,
  weekdays: r.time_block_weekdays.map(w => w.weekday).sort(),
  exceptions: r.time_block_exceptions.map(e => ({ id: e.id, timeBlockId: r.id, date: e.date })),
});

export async function fetchTimeZone(userId: string) {
  const data = check(await requireSupabase().from('profiles').select('time_zone').eq('id', userId).maybeSingle());
  return data?.time_zone ?? dayjs.tz.guess();
}

export async function fetchCategories(): Promise<Category[]> {
  const data = check(await requireSupabase().from('categories').select('id, user_id, name, color').order('id'));
  return (data ?? []).map(c => ({ id: c.id, userId: c.user_id, name: c.name, color: c.color }));
}

// Blocks that may have an occurrence in [from, to). Recurring bounds get a margin for
// overnight occurrences and zone differences; exact expansion happens client-side.
export async function fetchBlocks(from: Dayjs, to: Dayjs) {
  const db = requireSupabase();
  const [oneOff, recurring] = await Promise.all([
    db.from('time_blocks').select(SELECT).is('recurring_start_date', null)
      .lt('start_time', to.toISOString()).gt('end_time', from.toISOString()),
    db.from('time_blocks').select(SELECT).not('recurring_start_date', 'is', null)
      .lt('recurring_start_date', to.add(1, 'day').toISOString())
      .or(`recurring_end_date.is.null,recurring_end_date.gt."${from.subtract(2, 'day').toISOString()}"`),
  ]);
  return [...check(oneOff) ?? [], ...check(recurring) ?? []].map(r => fromRow(r as Row));
}

export async function saveBlock(draft: TimeBlockDraft, id?: string): Promise<string> {
  return check(await requireSupabase().rpc('save_time_block', {
    p_id: id ?? null, p_title: draft.title.trim(), p_category_id: draft.categoryId, p_availability: draft.availability,
    p_start_time: draft.startTime.toISOString(), p_end_time: draft.endTime.toISOString(),
    p_description: draft.description?.trim() || null,
    p_recurring_start_date: draft.recurringStartDate?.toISOString() ?? null,
    p_recurring_end_date: draft.recurringEndDate?.toISOString() ?? null,
    p_time_zone: draft.timezone, p_weekdays: draft.weekdays,
  }));
}

export async function deleteBlock(id: string) {
  check(await requireSupabase().from('time_blocks').delete().eq('id', id));
}

// date: local midnight of the occurrence in the block's zone.
export async function skipOccurrence(blockId: string, date: Dayjs) {
  check(await requireSupabase().from('time_block_exceptions').insert({ time_block_id: blockId, date: date.toISOString() }));
}

// Replace one occurrence with a standalone block: skip the date on the series, then save the copy.
export async function detachOccurrence(blockId: string, date: Dayjs, draft: TimeBlockDraft) {
  const id = await saveBlock(draft);
  try { await skipOccurrence(blockId, date); }
  catch (e) { await deleteBlock(id); throw e; }
  return id;
}
