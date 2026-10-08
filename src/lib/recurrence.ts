import type { Dayjs } from "dayjs";
import { dayjs } from "./time.ts";
import type { TimeBlock, RecurringBlock, TimeBlockException } from "../type.ts";

// Calendar dates stay plain strings: adding a calendar day must not cross a DST shift.
export const DATE = "YYYY-MM-DD";
export const addDays = (date: string, n: number) => dayjs.utc(date).add(n, "day").format(DATE);
export const weekdayOf = (date: string) => dayjs.utc(date).day();
export const localMidnight = (date: string, zone: string) => dayjs.tz(date, zone);
export const localDate = (t: Dayjs, zone: string) => t.tz(zone).format(DATE);
export const atClock = (date: string, clock: string, zone: string) => dayjs.tz(`${date} ${clock}`, zone);
export const isRecurring = (block: TimeBlock): block is RecurringBlock => block.kind === "recurring";

export type Occurrence = { block: TimeBlock; start: Dayjs; end: Dayjs; date: string | null };

export function wallClock(block: TimeBlock) {
  if (isRecurring(block)) return { start: block.startTime, end: block.endTime, dayOffset: block.endDayOffset };
  const s = dayjs(block.startAt).tz(block.timezone), e = dayjs(block.endAt).tz(block.timezone);
  return {
    start: s.format("HH:mm"), end: e.format("HH:mm"),
    dayOffset: dayjs.utc(e.format(DATE)).diff(dayjs.utc(s.format(DATE)), "day"),
  };
}

// Scheduled dates are counted before exceptions. Weeks are anchored to Sunday.
export function isScheduledDate(block: RecurringBlock, date: string): boolean {
  const r = block.recurrence;
  if (date < r.startDate || !Number.isInteger(r.interval) || r.interval < 1) return false;
  if (r.end.kind === "until" && date > r.end.date) return false;
  const weekdays = [...new Set(r.weekdays)].filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
  const weekday = weekdayOf(date);
  if (!weekdays.includes(weekday)) return false;
  const startWeekday = weekdayOf(r.startDate);
  const week = Math.floor(dayjs.utc(date).diff(dayjs.utc(addDays(r.startDate, -startWeekday)), "day") / 7);
  if (week % r.interval !== 0) return false;
  if (r.end.kind === "count") {
    const activeWeek = week / r.interval;
    const rank = activeWeek * weekdays.length
      - weekdays.filter(d => d < startWeekday).length
      + weekdays.filter(d => d <= weekday).length;
    if (rank > r.end.count || r.end.count < 1) return false;
  }
  return true;
}

// Expand only occurrences overlapping [from, to). Exceptions use the original local date.
export function occurrences(block: TimeBlock, exceptions: readonly TimeBlockException[], from: Dayjs, to: Dayjs): Occurrence[] {
  if (!from.isBefore(to)) return [];
  if (!isRecurring(block)) {
    const start = dayjs(block.startAt), end = dayjs(block.endAt);
    return start.isBefore(to) && end.isAfter(from) ? [{ block, start, end, date: null }] : [];
  }
  const zone = block.timezone, clock = wallClock(block);
  const suppressed = new Set(exceptions.filter(e => e.seriesId === block.id).map(e => e.occurrenceDate));
  const result: Occurrence[] = [];
  for (let d = addDays(localDate(from, zone), -clock.dayOffset), last = localDate(to, zone); d <= last; d = addDays(d, 1)) {
    if (!isScheduledDate(block, d) || suppressed.has(d)) continue;
    const start = atClock(d, clock.start, zone), end = atClock(addDays(d, clock.dayOffset), clock.end, zone);
    if (start.isBefore(to) && end.isAfter(from)) result.push({ block, start, end, date: d });
  }
  return result;
}

// Compatibility helper for callers needing an exclusive local boundary.
export function endAfterCount(startDate: string, weekdays: readonly number[], count: number, zone: string) {
  const validDays = [...new Set(weekdays)].filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
  if (!validDays.length || !Number.isInteger(count) || count < 1) throw new Error("A repeating block needs at least one weekday and one occurrence.");
  for (let d = startDate, n = 0; ; d = addDays(d, 1)) {
    if (validDays.includes(weekdayOf(d)) && ++n === count) return localMidnight(addDays(d, 1), zone);
  }
}

export type Segment = Occurrence & { top: number; bottom: number; continuesBefore: boolean; continuesAfter: boolean };
export function daySegment(occurrence: Occurrence, dayStart: Dayjs, dayEnd: Dayjs): Segment | null {
  const { start, end } = occurrence;
  if (!start.isBefore(dayEnd) || !end.isAfter(dayStart)) return null;
  const minutes = (t: Dayjs) => Math.round(t.diff(dayStart, "minute", true));
  return { ...occurrence, top: start.isAfter(dayStart) ? minutes(start) : 0, bottom: end.isBefore(dayEnd) ? minutes(end) : minutes(dayEnd), continuesBefore: start.isBefore(dayStart), continuesAfter: end.isAfter(dayEnd) };
}

export function layoutLanes<T extends { top: number; bottom: number }>(segments: readonly T[]) {
  const sorted = [...segments].sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  const placed: (T & { lane: number; lanes: number })[] = [];
  let cluster: (T & { lane: number; lanes: number })[] = [], laneEnds: number[] = [], clusterEnd = -1;
  const flush = () => { for (const s of cluster) s.lanes = laneEnds.length; cluster = []; laneEnds = []; };
  for (const segment of sorted) {
    if (segment.top >= clusterEnd) flush();
    let lane = laneEnds.findIndex(end => end <= segment.top);
    if (lane === -1) lane = laneEnds.push(0) - 1;
    laneEnds[lane] = segment.bottom;
    clusterEnd = Math.max(clusterEnd, segment.bottom);
    const item = { ...segment, lane, lanes: 1 };
    cluster.push(item); placed.push(item);
  }
  flush(); return placed;
}
