export type Availability = "busy" | "flexible";
export type Category = {
  id: number;
  userId: string;
  name: string;
  color: string;
};
export type BlockBase = {
  id: string;
  userId: string;
  title: string;
  categoryId: number;
  availability: Availability;
  description?: string;
  timezone: string;
};
export type OneOffBlock = BlockBase & {
  kind: "oneOff";
  startAt: string;
  endAt: string;
  detachedFrom?: { seriesId: string; occurrenceDate: string };
};
export type RecurrenceEnd =
  | { kind: "never" }
  | { kind: "until"; date: string }
  | { kind: "count"; count: number };
export type RecurringBlock = BlockBase & {
  kind: "recurring";
  startTime: string;
  endTime: string;
  endDayOffset: number;
  recurrence: {
    frequency: "weekly";
    interval: number;
    weekdays: number[];
    startDate: string;
    end: RecurrenceEnd;
  };
};
export type TimeBlock = OneOffBlock | RecurringBlock;
export type OneOffBlockDraft = Omit<OneOffBlock, "id" | "userId">;
export type RecurringBlockDraft = Omit<RecurringBlock, "id" | "userId">;
export type TimeBlockDraft = OneOffBlockDraft | RecurringBlockDraft;
export type TimeBlockException = {
  id: number;
  seriesId: string;
  occurrenceDate: string;
} & ({ kind: "skipped" } | { kind: "replaced"; replacementBlockId: string });
