import { test } from "node:test";
import assert from "node:assert/strict";
import {
  atClock,
  daySegment,
  isScheduledDate,
  layoutLanes,
  localMidnight,
  occurrences,
  wallClock,
} from "../src/lib/recurrence.ts";
import type {
  OneOffBlock,
  RecurringBlock,
  TimeBlockException,
} from "../src/type.ts";
const zone = "America/New_York";
const base = {
  id: "b1",
  userId: "u1",
  title: "Gym",
  categoryId: 1,
  availability: "busy" as const,
  timezone: zone,
};
const series = (
  overrides: Partial<RecurringBlock["recurrence"]> = {},
): RecurringBlock => ({
  ...base,
  kind: "recurring",
  startTime: "09:00",
  endTime: "10:00",
  endDayOffset: 0,
  recurrence: {
    frequency: "weekly",
    interval: 1,
    weekdays: [1, 3, 5],
    startDate: "2026-10-01",
    end: { kind: "never" },
    ...overrides,
  },
});
const oneOff = (): OneOffBlock => ({
  ...base,
  kind: "oneOff",
  startAt: atClock("2026-10-05", "09:00", zone).toISOString(),
  endAt: atClock("2026-10-05", "10:00", zone).toISOString(),
});
const from = localMidnight("2026-10-04", zone),
  to = localMidnight("2026-10-11", zone);
const dates = (b: RecurringBlock, exceptions: TimeBlockException[] = []) =>
  occurrences(b, exceptions, from, to).map((o) => o.date);

test("one-off overlap is half-open and wall clock uses its timezone", () => {
  const b = oneOff();
  assert.equal(occurrences(b, [], from, to).length, 1);
  assert.equal(occurrences(b, [], to, to.add(7, "day")).length, 0);
  assert.equal(
    occurrences(b, [], atClock("2026-10-05", "10:00", zone), to).length,
    0,
  );
  assert.deepEqual(wallClock(b), {
    start: "09:00",
    end: "10:00",
    dayOffset: 0,
  });
});
test("local weekly schedule and inclusive until date", () => {
  assert.deepEqual(dates(series()), ["2026-10-05", "2026-10-07", "2026-10-09"]);
  assert.deepEqual(
    dates(
      series({
        startDate: "2026-10-06",
        end: { kind: "until", date: "2026-10-09" },
      }),
    ),
    ["2026-10-07", "2026-10-09"],
  );
});
test("interval anchors to Sunday in start week, including a partial first week", () => {
  const b = series({
    startDate: "2026-10-07",
    interval: 2,
    weekdays: [0, 1, 3],
  });
  const result = occurrences(b, [], from, localMidnight("2026-10-26", zone));
  assert.deepEqual(
    result.map((o) => o.date),
    ["2026-10-07", "2026-10-18", "2026-10-19", "2026-10-21"],
  );
});
test("count counts scheduled dates, including skipped and replaced dates", () => {
  const b = series({
    startDate: "2026-10-07",
    interval: 2,
    weekdays: [0, 1, 3, 3],
    end: { kind: "count", count: 3 },
  });
  const exceptions: TimeBlockException[] = [
    { id: 1, seriesId: b.id, occurrenceDate: "2026-10-07", kind: "skipped" },
    {
      id: 2,
      seriesId: b.id,
      occurrenceDate: "2026-10-18",
      kind: "replaced",
      replacementBlockId: "r1",
    },
  ];
  assert.deepEqual(
    occurrences(b, exceptions, from, localMidnight("2026-11-01", zone)).map(
      (o) => o.date,
    ),
    ["2026-10-19"],
  );
  assert.equal(isScheduledDate(b, "2026-10-21"), false);
  assert.equal(isScheduledDate(b, "2026-10-05"), false);
});
test("exceptions use local dates and only suppress their own series", () => {
  const b = series();
  assert.deepEqual(
    dates(b, [
      {
        id: 1,
        seriesId: "other",
        occurrenceDate: "2026-10-05",
        kind: "skipped",
      },
    ]),
    dates(b),
  );
  assert.deepEqual(
    dates(b, [
      { id: 1, seriesId: b.id, occurrenceDate: "2026-10-05", kind: "skipped" },
    ]),
    ["2026-10-07", "2026-10-09"],
  );
});
test("moved replacement is independent; restoring removes replacement and original exception", () => {
  const b = series();
  const replacement: OneOffBlock = {
    ...oneOff(),
    id: "r1",
    detachedFrom: { seriesId: b.id, occurrenceDate: "2026-10-05" },
    startAt: atClock("2026-11-12", "15:00", zone).toISOString(),
    endAt: atClock("2026-11-12", "16:00", zone).toISOString(),
  };
  const exception: TimeBlockException = {
    id: 1,
    seriesId: b.id,
    occurrenceDate: "2026-10-05",
    kind: "replaced",
    replacementBlockId: replacement.id,
  };
  assert.deepEqual(dates(b, [exception]), ["2026-10-07", "2026-10-09"]);
  assert.equal(
    occurrences(
      replacement,
      [exception],
      localMidnight("2026-11-12", zone),
      localMidnight("2026-11-13", zone),
    ).length,
    1,
  );
  assert.equal(
    isScheduledDate(b, replacement.detachedFrom!.occurrenceDate),
    true,
  );
  assert.deepEqual(dates(b), ["2026-10-05", "2026-10-07", "2026-10-09"]);
});
test("overnight occurrence from previous week overlaps this week", () => {
  const b = {
    ...series({ weekdays: [6], startDate: "2026-09-01" }),
    startTime: "22:00",
    endTime: "01:00",
    endDayOffset: 1,
  };
  assert.deepEqual(dates(b), ["2026-10-03", "2026-10-10"]);
});
test("local wall-clock schedule survives spring and autumn DST changes", () => {
  for (const [before, after] of [
    ["2026-03-07", "2026-03-08"],
    ["2026-10-31", "2026-11-01"],
  ]) {
    const b = series({ startDate: before, weekdays: [0, 6] });
    const result = occurrences(
      b,
      [],
      localMidnight(before, zone),
      localMidnight(after, zone).add(1, "day"),
    );
    assert.deepEqual(
      result.map((o) => o.start.tz(zone).format("HH:mm")),
      ["09:00", "09:00"],
    );
    assert.notEqual(result[0].start.utcOffset(), result[1].start.utcOffset());
  }
});
test("overnight DST endpoints are resolved separately in local time", () => {
  const b = {
    ...series({ startDate: "2026-10-31", weekdays: [6] }),
    startTime: "22:00",
    endTime: "03:00",
    endDayOffset: 1,
  };
  const [o] = occurrences(
    b,
    [],
    localMidnight("2026-10-31", zone),
    localMidnight("2026-11-02", zone),
  );
  assert.equal(o.end.diff(o.start, "hour"), 6);
});
test("day segments split overnight blocks and overlapping lanes stay separate", () => {
  const o = {
    block: oneOff(),
    start: atClock("2026-10-05", "22:00", zone),
    end: atClock("2026-10-06", "01:00", zone),
    date: null,
  };
  const first = daySegment(
    o,
    localMidnight("2026-10-05", zone),
    localMidnight("2026-10-06", zone),
  );
  const second = daySegment(
    o,
    localMidnight("2026-10-06", zone),
    localMidnight("2026-10-07", zone),
  );
  assert.deepEqual(
    [first?.top, first?.bottom, first?.continuesAfter],
    [1320, 1440, true],
  );
  assert.deepEqual(
    [second?.top, second?.bottom, second?.continuesBefore],
    [0, 60, true],
  );
  assert.deepEqual(
    layoutLanes([
      { top: 0, bottom: 60 },
      { top: 30, bottom: 90 },
      { top: 120, bottom: 180 },
    ]).map((s) => [s.lane, s.lanes]),
    [
      [0, 2],
      [1, 2],
      [0, 1],
    ],
  );
});
