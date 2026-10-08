import { addDays, atClock, isScheduledDate } from "./recurrence";
import type { Dayjs } from "dayjs";
import { dayjs } from "./time";
import { requireSupabase } from "./supabase";
import { TIME_BLOCK_SELECT as SELECT } from "./timeBlockSelect";
import type {
  Availability,
  Category,
  TimeBlock,
  TimeBlockDraft,
  OneOffBlockDraft,
  TimeBlockException,
} from "../type";
export type PlannerBlock = TimeBlock & {
  exceptions: TimeBlockException[];
};
type Row = {
  id: string;
  user_id: string;
  title: string;
  category_id: number;
  availability: Availability;
  description: string | null;
  time_zone: string;
  kind: "oneOff" | "recurring";
  start_at: string;
  end_at: string;
  local_start_time: string;
  local_end_time: string;
  end_day_offset: number;
  recurrence_start_date: string;
  recurrence_until_date: string | null;
  recurrence_count: number | null;
  recurrence_interval: number;
  origin_series_id: string | null;
  origin_occurrence_date: string | null;
  time_block_weekdays: {
    weekday: number;
  }[];
  time_block_exceptions: {
    id: number;
    occurrence_date: string;
    kind: "skipped" | "replaced";
    replacement_block_id: string | null;
  }[];
};
const check = <T>({
  data,
  error,
}: {
  data: T;
  error: {
    message: string;
  } | null;
}) => {
  if (error) throw new Error(error.message);
  return data;
};
const fromRow = (r: Row): PlannerBlock => {
  const base = {
    id: r.id,
    userId: r.user_id,
    title: r.title,
    categoryId: r.category_id,
    availability: r.availability,
    description: r.description ?? undefined,
    timezone: r.time_zone,
    exceptions: r.time_block_exceptions.map((e): TimeBlockException =>
      e.kind === "replaced"
        ? {
            id: e.id,
            seriesId: r.id,
            occurrenceDate: e.occurrence_date,
            kind: "replaced",
            replacementBlockId: e.replacement_block_id!,
          }
        : {
            id: e.id,
            seriesId: r.id,
            occurrenceDate: e.occurrence_date,
            kind: "skipped",
          },
    ),
  };
  return r.kind === "oneOff"
    ? {
        ...base,
        kind: "oneOff",
        startAt: r.start_at,
        endAt: r.end_at,
        detachedFrom: r.origin_series_id
          ? {
              seriesId: r.origin_series_id,
              occurrenceDate: r.origin_occurrence_date!,
            }
          : undefined,
      }
    : {
        ...base,
        kind: "recurring",
        startTime: r.local_start_time.slice(0, 5),
        endTime: r.local_end_time.slice(0, 5),
        endDayOffset: r.end_day_offset,
        recurrence: {
          frequency: "weekly",
          interval: r.recurrence_interval,
          weekdays: r.time_block_weekdays.map((w) => w.weekday).sort(),
          startDate: r.recurrence_start_date,
          end: r.recurrence_until_date
            ? { kind: "until", date: r.recurrence_until_date }
            : r.recurrence_count !== null
              ? { kind: "count", count: r.recurrence_count }
              : { kind: "never" },
        },
      };
};
export async function fetchTimeZone(userId: string) {
  const data = check(
    await requireSupabase()
      .from("profiles")
      .select("time_zone")
      .eq("id", userId)
      .maybeSingle(),
  );
  return data?.time_zone ?? dayjs.tz.guess();
}
export async function fetchCategories(): Promise<Category[]> {
  const data = check(
    await requireSupabase()
      .from("categories")
      .select("id, user_id, name, color")
      .order("id"),
  );
  return (data ?? []).map((c) => ({
    id: c.id,
    userId: c.user_id,
    name: c.name,
    color: c.color,
  }));
}
export async function fetchBlocks(
  from: Dayjs,
  to: Dayjs,
): Promise<PlannerBlock[]> {
  const db = requireSupabase();
  const results = await Promise.all([
    db
      .from("time_blocks")
      .select(SELECT)
      .eq("kind", "oneOff")
      .lt("start_at", to.toISOString())
      .gt("end_at", from.toISOString()),
    db
      .from("time_blocks")
      .select(SELECT)
      .eq("kind", "recurring")
      .lte("recurrence_start_date", to.add(2, "day").format("YYYY-MM-DD")),
  ]);
  return results.flatMap((r) =>
    (check(r) ?? []).map((row) => fromRow(row as Row)),
  );
}
export async function saveBlock(
  draft: TimeBlockDraft,
  id?: string,
): Promise<string> {
  return check(
    await requireSupabase().rpc("save_time_block", {
      p_draft: draft,
      p_id: id ?? null,
    }),
  );
}
export async function deleteBlock(id: string) {
  check(await requireSupabase().rpc("delete_time_block", { p_id: id }));
}
export async function skipOccurrence(seriesId: string, occurrenceDate: string) {
  check(
    await requireSupabase().rpc("skip_occurrence", {
      p_series_id: seriesId,
      p_occurrence_date: occurrenceDate,
    }),
  );
}
export async function detachOccurrence(
  seriesId: string,
  occurrenceDate: string,
  draft: OneOffBlockDraft,
): Promise<string> {
  return check(
    await requireSupabase().rpc("detach_occurrence", {
      p_series_id: seriesId,
      p_occurrence_date: occurrenceDate,
      p_draft: draft,
    }),
  );
}
export async function restoreOccurrence(replacementBlockId: string) {
  check(
    await requireSupabase().rpc("restore_occurrence", {
      p_replacement_id: replacementBlockId,
    }),
  );
}
export async function fetchOriginSeries(
  seriesId: string,
): Promise<PlannerBlock | null> {
  const row = check(
    await requireSupabase()
      .from("time_blocks")
      .select(SELECT)
      .eq("id", seriesId)
      .maybeSingle(),
  );
  return row ? fromRow(row as Row) : null;
}

export async function getRestorePreview(replacementBlockId: string) {
  const replacement = await fetchOriginSeries(replacementBlockId);
  if (replacement?.kind !== "oneOff" || !replacement.detachedFrom) return null;
  const { seriesId, occurrenceDate } = replacement.detachedFrom;
  const series = await fetchOriginSeries(seriesId);
  if (series?.kind !== "recurring" || !isScheduledDate(series, occurrenceDate))
    return null;
  return {
    series,
    occurrence: {
      block: series,
      date: occurrenceDate,
      start: atClock(occurrenceDate, series.startTime, series.timezone),
      end: atClock(
        addDays(occurrenceDate, series.endDayOffset),
        series.endTime,
        series.timezone,
      ),
    },
  };
}

