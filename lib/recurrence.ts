import type { Dayjs } from "dayjs";
import { dayjs } from "./time.ts";
import type { TimeBlock, TimeBlockException } from "../type.ts";

// Calendar dates are plain 'YYYY-MM-DD' strings so day arithmetic never crosses DST shifts.
export const DATE = "YYYY-MM-DD";
export const addDays = (date: string, n: number) =>
  dayjs.utc(date).add(n, "day").format(DATE);
export const weekdayOf = (date: string) => dayjs.utc(date).day();
export const localMidnight = (date: string, zone: string) =>
  dayjs.tz(date, zone);
export const localDate = (t: Dayjs, zone: string) => t.tz(zone).format(DATE);
export const atClock = (date: string, clock: string, zone: string) =>
  dayjs.tz(`${date} ${clock}`, zone);

export const isRecurring = (block: TimeBlock) =>
  block.recurringStartDate != null;

// date: the occurrence's local start date in the block's zone (recurring only), used as the exception key.
export type Occurrence = {
  block: TimeBlock;
  start: Dayjs;
  end: Dayjs;
  date: string | null;
};

// Wall-clock times of a block in its own zone; dayOffset > 0 means it ends on a later day.
export function wallClock(block: TimeBlock) {
  const s = block.startTime.tz(block.timezone),
    e = block.endTime.tz(block.timezone);
  return {
    start: s.format("HH:mm"),
    end: e.format("HH:mm"),
    dayOffset: dayjs.utc(e.format(DATE)).diff(dayjs.utc(s.format(DATE)), "day"),
  };
}

// All occurrences of a block that overlap [from, to).
export function occurrences(
  block: TimeBlock,
  exceptions: readonly TimeBlockException[],
  from: Dayjs,
  to: Dayjs,
): Occurrence[] {
  if (!block.recurringStartDate)
    return block.startTime.isBefore(to) && block.endTime.isAfter(from)
      ? [{ block, start: block.startTime, end: block.endTime, date: null }]
      : [];
  const zone = block.timezone,
    clock = wallClock(block);
  const skipped = new Set(exceptions.map((e) => dayjs(e.date).valueOf()));
  const result: Occurrence[] = [];
  // Start early enough to catch occurrences that began before `from` and run into it.
  for (
    let d = addDays(localDate(from, zone), -clock.dayOffset),
      last = localDate(to, zone);
    d <= last;
    d = addDays(d, 1)
  ) {
    const midnight = localMidnight(d, zone);
    if (
      midnight.isBefore(block.recurringStartDate) ||
      (block.recurringEndDate && !midnight.isBefore(block.recurringEndDate))
    )
      continue;
    if (
      !block.weekdays.includes(weekdayOf(d)) ||
      skipped.has(midnight.valueOf())
    )
      continue;
    const start = atClock(d, clock.start, zone),
      end = atClock(addDays(d, clock.dayOffset), clock.end, zone);
    if (start.isBefore(to) && end.isAfter(from))
      result.push({ block, start, end, date: d });
  }
  return result;
}

// Exclusive recurrence end (local midnight) that leaves exactly `count` occurrences starting at startDate.
export function endAfterCount(
  startDate: string,
  weekdays: readonly number[],
  count: number,
  zone: string,
) {
  if (!weekdays.length || count < 1)
    throw new Error(
      "A repeating block needs at least one weekday and one occurrence.",
    );
  for (let d = startDate, n = 0; ; d = addDays(d, 1)) {
    if (weekdays.includes(weekdayOf(d)) && ++n === count)
      return localMidnight(addDays(d, 1), zone);
  }
}

// The part of an occurrence inside one day, as minutes from that day's start.
export type Segment = Occurrence & {
  top: number;
  bottom: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
};

export function daySegment(
  occurrence: Occurrence,
  dayStart: Dayjs,
  dayEnd: Dayjs,
): Segment | null {
  const { start, end } = occurrence;
  if (!start.isBefore(dayEnd) || !end.isAfter(dayStart)) return null;
  const minutes = (t: Dayjs) => Math.round(t.diff(dayStart, "minute", true));
  return {
    ...occurrence,
    top: start.isAfter(dayStart) ? minutes(start) : 0,
    bottom: end.isBefore(dayEnd) ? minutes(end) : minutes(dayEnd),
    continuesBefore: start.isBefore(dayStart),
    continuesAfter: end.isAfter(dayEnd),
  };
}

// Side-by-side lanes for overlapping segments within a day.
export function layoutLanes<T extends { top: number; bottom: number }>(
  segments: readonly T[],
) {
  const sorted = [...segments].sort(
    (a, b) => a.top - b.top || b.bottom - a.bottom,
  );
  const placed: (T & { lane: number; lanes: number })[] = [];
  let cluster: (T & { lane: number; lanes: number })[] = [],
    laneEnds: number[] = [],
    clusterEnd = -1;
  const flush = () => {
    for (const s of cluster) s.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };
  for (const segment of sorted) {
    if (segment.top >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= segment.top);
    if (lane === -1) lane = laneEnds.push(0) - 1;
    laneEnds[lane] = segment.bottom;
    clusterEnd = Math.max(clusterEnd, segment.bottom);
    const item = { ...segment, lane, lanes: 1 };
    cluster.push(item);
    placed.push(item);
  }
  flush();
  return placed;
}
