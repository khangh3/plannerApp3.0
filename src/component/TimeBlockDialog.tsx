import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SpinnerGapIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import {
  addDays,
  atClock,
  localDate,
  wallClock,
  weekdayOf,
  type Occurrence,
} from "../lib/recurrence";
import {
  deleteBlock,
  detachOccurrence,
  getRestorePreview,
  restoreOccurrence,
  saveBlock,
  skipOccurrence,
} from "../lib/timeBlocks";
import { ErrorBanner } from "./AuthLayout";
import type { Availability, Category, TimeBlockDraft } from "../type";

export type DialogTarget =
  | { kind: "create"; date: string; start: string }
  | { kind: "edit"; occurrence: Occurrence };

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

type Form = {
  title: string;
  categoryId: number;
  availability: Availability;
  description: string;
  date: string;
  seriesStart: string;
  start: string;
  end: string;
  endDayOffset: number;
  interval: number;
  repeat: boolean;
  weekdays: number[];
  endMode: "never" | "until" | "count";
  until: string;
  count: number;
  scope: "occurrence" | "series";
};

function initialForm(target: DialogTarget, categories: Category[]): Form {
  if (target.kind === "create") {
    const [h, m] = target.start.split(":").map(Number);
    const end = `${String((h + 1) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    return {
      title: "",
      categoryId: categories[0]?.id ?? 0,
      availability: "busy",
      description: "",
      date: target.date,
      seriesStart: target.date,
      start: target.start,
      end,
      endDayOffset: h === 23 ? 1 : 0,
      interval: 1,
      repeat: false,
      weekdays: [weekdayOf(target.date)],
      endMode: "never",
      until: addDays(target.date, 28),
      count: 10,
      scope: "series",
    };
  }
  const { block, start, date } = target.occurrence,
    clock = wallClock(block);
  const occurrenceDate = date ?? localDate(start, block.timezone);
  const recurrence = block.kind === "recurring" ? block.recurrence : null;
  const seriesStart = recurrence?.startDate ?? occurrenceDate;
  return {
    title: block.title,
    categoryId: block.categoryId,
    availability: block.availability,
    description: block.description ?? "",
    date: occurrenceDate,
    seriesStart,
    start: clock.start,
    end: clock.end,
    endDayOffset: clock.dayOffset,
    interval: recurrence?.interval ?? 1,
    repeat: !!recurrence,
    weekdays: recurrence?.weekdays ?? [weekdayOf(occurrenceDate)],
    endMode: recurrence?.end.kind ?? "never",
    until:
      recurrence?.end.kind === "until"
        ? recurrence.end.date
        : addDays(seriesStart, 28),
    count: recurrence?.end.kind === "count" ? recurrence.end.count : 10,
    scope: "occurrence",
  };
}

function toDraft(f: Form, zone: string, asSeries: boolean): TimeBlockDraft {
  if (!f.title.trim()) throw new Error("Give the block a title.");
  if (!Number.isInteger(f.endDayOffset) || f.endDayOffset < 0)
    throw new Error("Choose a valid end day.");
  if (!f.endDayOffset && f.end <= f.start)
    throw new Error(
      "The end must be after the start. Choose a later end day for overnight blocks.",
    );
  const day = asSeries ? f.seriesStart : f.date;
  const startTime = atClock(day, f.start, zone),
    endTime = atClock(addDays(day, f.endDayOffset), f.end, zone);
  const base = {
    title: f.title.trim(),
    categoryId: f.categoryId,
    availability: f.availability,
    description: f.description,
    timezone: zone,
  };
  if (!asSeries)
    return {
      ...base,
      kind: "oneOff",
      startAt: startTime.toISOString(),
      endAt: endTime.toISOString(),
    };
  if (!f.weekdays.length)
    throw new Error("Pick at least one weekday to repeat on.");
  if (f.endMode === "until" && f.until < f.seriesStart)
    throw new Error("The repeat end date must be on or after the start date.");
  if (f.endMode === "count" && (!Number.isInteger(f.count) || f.count < 1))
    throw new Error("Repeat a whole number of times, at least once.");
  if (!Number.isInteger(f.interval) || f.interval < 1)
    throw new Error("Repeat every whole number of weeks, at least one.");
  const end =
    f.endMode === "until"
      ? { kind: "until" as const, date: f.until }
      : f.endMode === "count"
        ? { kind: "count" as const, count: f.count }
        : { kind: "never" as const };
  return {
    ...base,
    kind: "recurring",
    startTime: f.start,
    endTime: f.end,
    endDayOffset: f.endDayOffset,
    recurrence: {
      frequency: "weekly",
      interval: f.interval,
      weekdays: f.weekdays,
      startDate: f.seriesStart,
      end,
    },
  };
}

export function TimeBlockDialog({
  target,
  categories,
  zone,
  onClose,
}: {
  target: DialogTarget;
  categories: Category[];
  zone: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => initialForm(target, categories));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const editing = target.kind === "edit" ? target.occurrence : null;
  const block = editing?.block;
  // Edits keep the block's own zone so its wall-clock times don't shift.
  const blockZone = block?.timezone ?? zone;
  const editingSeries = block?.kind === "recurring";
  const detachedFrom =
    block?.kind === "oneOff" ? block.detachedFrom : undefined;
  const preview = useQuery({
    queryKey: ["timeBlocks", "restorePreview", block?.id],
    queryFn: () => getRestorePreview(block!.id),
    enabled: !!detachedFrom,
  });
  const onlyOccurrence = editingSeries && form.scope === "occurrence";
  const asSeries = form.repeat && !onlyOccurrence;

  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: ["timeBlocks"] });
    onClose();
  };
  const save = useMutation({
    mutationFn: async () => {
      const draft = toDraft(form, blockZone, asSeries);
      if (!editing || !block) return saveBlock(draft);
      if (onlyOccurrence && draft.kind === "oneOff")
        return detachOccurrence(block.id, editing.date!, draft);
      return saveBlock(
        draft.kind === "oneOff" && detachedFrom
          ? { ...draft, detachedFrom }
          : draft,
        block.id,
      );
    },
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (!editing || !block) return;
      if (onlyOccurrence) return skipOccurrence(block.id, editing.date!);
      return deleteBlock(block.id);
    },
    onSuccess: done,
  });
  const restore = useMutation({
    mutationFn: () => restoreOccurrence(block!.id),
    onSuccess: done,
  });
  const pending = save.isPending || remove.isPending || restore.isPending;
  const error = save.error ?? remove.error ?? restore.error;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleRepeat = (repeat: boolean) =>
    setForm((f) => ({
      ...f,
      repeat,
      seriesStart: editingSeries ? f.seriesStart : f.date,
    }));
  const toggleWeekday = (d: number) =>
    set(
      "weekdays",
      form.weekdays.includes(d)
        ? form.weekdays.filter((w) => w !== d)
        : [...form.weekdays, d].sort(),
    );
  const input =
    "mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";

  return (
    <div
      className='fixed inset-0 z-50 flex items-center justify-center bg-stone-900/30 p-4'
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}>
      <section
        role='dialog'
        aria-modal='true'
        aria-labelledby='block-dialog-title'
        className='max-h-full w-full max-w-md overflow-y-auto rounded-2xl border border-stone-200 bg-white p-6 shadow-xl'>
        <div className='flex items-center justify-between'>
          <h2
            id='block-dialog-title'
            className='text-lg font-semibold text-stone-900'>
            {editing ? "Edit time block" : "New time block"}
          </h2>
          <button
            type='button'
            onClick={onClose}
            aria-label='Close'
            className='rounded-md p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-600'>
            <XIcon size={18} />
          </button>
        </div>

        <form
          className='mt-4 space-y-4'
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}>
          {detachedFrom && (
            <div className='space-y-2 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-stone-700'>
              <p>
                This independent block was detached from the series occurrence
                on {dateLabel(detachedFrom.occurrenceDate)} (
                {detachedFrom.occurrenceDate}). Series edits do not change it.
              </p>
              {preview.isPending ? (
                <p>Checking the current series…</p>
              ) : preview.error ? (
                <ErrorBanner message={preview.error.message} />
              ) : preview.data ? (
                <>
                  <p>
                    Restore to <strong>{preview.data.series.title}</strong>:{" "}
                    {preview.data.occurrence.start
                      .tz(preview.data.series.timezone)
                      .format("MMM D, YYYY h:mm A")}{" "}
                    –{" "}
                    {preview.data.occurrence.end
                      .tz(preview.data.series.timezone)
                      .format("MMM D, YYYY h:mm A")}{" "}
                    ({preview.data.series.timezone}).
                  </p>
                  <p>
                    {categories.find(
                      (c) => c.id === preview.data?.series.categoryId,
                    )?.name ?? "Category"}{" "}
                    · {preview.data.series.availability}
                    {preview.data.series.description
                      ? ` · ${preview.data.series.description}`
                      : ""}
                  </p>
                  {confirmRestore && (
                    <p className='font-medium'>
                      Restoring deletes this independent block and discards all
                      its custom changes, including unsaved edits. The
                      occurrence will follow the current series shown above.
                    </p>
                  )}
                  <button
                    type='button'
                    disabled={pending}
                    onClick={() =>
                      confirmRestore
                        ? restore.mutate()
                        : setConfirmRestore(true)
                    }
                    className='rounded-lg border border-indigo-300 bg-white px-3 py-2 font-medium text-indigo-700 disabled:opacity-60'>
                    {restore.isPending
                      ? "Restoring…"
                      : confirmRestore
                        ? "Confirm restore and discard changes"
                        : "Restore to series"}
                  </button>
                  {confirmRestore && (
                    <button
                      type='button'
                      className='ml-2 text-stone-600'
                      onClick={() => setConfirmRestore(false)}>
                      Keep independent
                    </button>
                  )}
                </>
              ) : (
                <p>
                  The original series no longer schedules this date, or has been
                  deleted. This block remains independent and cannot currently
                  be restored.
                </p>
              )}
            </div>
          )}
          {editingSeries && (
            <Segmented
              label='Apply changes to'
              value={form.scope}
              onChange={(v) => set("scope", v)}
              options={[
                ["occurrence", `Only ${dateLabel(editing!.date!)}`],
                ["series", "Entire series"],
              ]}
            />
          )}

          <label className='block text-sm font-medium text-stone-700'>
            Title
            <input
              autoFocus
              required
              className={input}
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder='Deep work'
            />
          </label>

          <div className='grid grid-cols-2 gap-3'>
            <label className='block text-sm font-medium text-stone-700'>
              Category
              <select
                className={input}
                value={form.categoryId}
                onChange={(e) => set("categoryId", Number(e.target.value))}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className='block text-sm font-medium text-stone-700'>
              Availability
              <select
                className={input}
                value={form.availability}
                onChange={(e) =>
                  set("availability", e.target.value as Availability)
                }>
                <option value='busy'>Busy</option>
                <option value='flexible'>Flexible</option>
              </select>
            </label>
          </div>

          <div className='grid grid-cols-[1.4fr_1fr_1fr] gap-3'>
            {asSeries ? (
              <label className='block text-sm font-medium text-stone-700'>
                Starts on
                <input
                  type='date'
                  required
                  className={input}
                  value={form.seriesStart}
                  onChange={(e) => set("seriesStart", e.target.value)}
                />
              </label>
            ) : (
              <label className='block text-sm font-medium text-stone-700'>
                Date
                <input
                  type='date'
                  required
                  className={input}
                  value={form.date}
                  onChange={(e) => set("date", e.target.value)}
                />
              </label>
            )}
            <label className='block text-sm font-medium text-stone-700'>
              Start
              <input
                type='time'
                required
                className={input}
                value={form.start}
                onChange={(e) => set("start", e.target.value)}
              />
            </label>
            <label className='block text-sm font-medium text-stone-700'>
              End
              <input
                type='time'
                required
                className={input}
                value={form.end}
                onChange={(e) => set("end", e.target.value)}
              />
            </label>
          </div>
          <label className='flex items-center gap-2 text-sm text-stone-700'>
            End day
            <input
              type='number'
              min={0}
              required
              className='w-20 rounded-lg border border-stone-300 px-2 py-1 text-sm'
              value={form.endDayOffset}
              onChange={(e) => set("endDayOffset", e.target.valueAsNumber)}
            />{" "}
            days after start
          </label>
          {form.endDayOffset > 0 && (
            <p className='-mt-2 text-xs text-stone-500'>
              Ends{" "}
              {form.endDayOffset === 1
                ? "the next day"
                : `${form.endDayOffset} days later`}{" "}
              at {form.end}.
            </p>
          )}
          {blockZone !== zone && (
            <p className='-mt-2 text-xs text-stone-500'>
              Times are in {blockZone}.
            </p>
          )}

          {!onlyOccurrence && !detachedFrom && (
            <div className='space-y-3 rounded-xl border border-stone-200 p-3'>
              <label className='flex items-center gap-2 text-sm font-medium text-stone-700'>
                <input
                  type='checkbox'
                  className='size-4 accent-indigo-600'
                  checked={form.repeat}
                  onChange={(e) => toggleRepeat(e.target.checked)}
                />
                Repeat weekly
              </label>
              {form.repeat && (
                <>
                  <label className='flex items-center gap-2 text-sm text-stone-700'>
                    Every
                    <input
                      type='number'
                      required
                      min={1}
                      className='w-20 rounded-lg border border-stone-300 px-2 py-1 text-sm'
                      value={form.interval}
                      onChange={(e) => set("interval", e.target.valueAsNumber)}
                    />{" "}
                    weeks
                  </label>
                  <div
                    className='flex gap-1.5'
                    role='group'
                    aria-label='Repeat on'>
                    {WEEKDAYS.map((d, i) => (
                      <button
                        key={i}
                        type='button'
                        aria-label={WEEKDAY_NAMES[i]}
                        aria-pressed={form.weekdays.includes(i)}
                        onClick={() => toggleWeekday(i)}
                        className={`size-8 rounded-full text-xs font-semibold ${form.weekdays.includes(i) ? "bg-indigo-600 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"}`}>
                        {d}
                      </button>
                    ))}
                  </div>
                  <div className='flex flex-wrap items-center gap-2 text-sm text-stone-700'>
                    <span>Ends</span>
                    <select
                      className='rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-sm'
                      value={form.endMode}
                      onChange={(e) =>
                        set("endMode", e.target.value as Form["endMode"])
                      }>
                      <option value='never'>Never</option>
                      <option value='until'>On date</option>
                      <option value='count'>After</option>
                    </select>
                    {form.endMode === "until" && (
                      <input
                        type='date'
                        required
                        className='rounded-lg border border-stone-300 px-2 py-1 text-sm'
                        value={form.until}
                        min={form.seriesStart}
                        onChange={(e) => set("until", e.target.value)}
                      />
                    )}
                    {form.endMode === "count" && (
                      <>
                        <input
                          type='number'
                          required
                          min={1}
                          max={999}
                          className='w-20 rounded-lg border border-stone-300 px-2 py-1 text-sm'
                          value={form.count}
                          onChange={(e) => set("count", e.target.valueAsNumber)}
                        />
                        occurrences
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          <label className='block text-sm font-medium text-stone-700'>
            Notes
            <textarea
              rows={2}
              className={input}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder='Optional'
            />
          </label>

          {error && <ErrorBanner message={error.message} />}

          <div className='flex items-center justify-between gap-2 pt-1'>
            {editing ? (
              <button
                type='button'
                disabled={pending}
                onClick={() =>
                  confirmDelete ? remove.mutate() : setConfirmDelete(true)
                }
                className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-60 ${confirmDelete ? "bg-red-600 text-white hover:bg-red-700" : "text-red-600 hover:bg-red-50"}`}>
                {remove.isPending ? (
                  <SpinnerGapIcon size={16} className='animate-spin' />
                ) : (
                  <TrashIcon size={16} />
                )}
                {confirmDelete
                  ? onlyOccurrence
                    ? "Skip this date?"
                    : "Confirm delete"
                  : onlyOccurrence
                    ? "Delete occurrence"
                    : editingSeries
                      ? "Delete series"
                      : "Delete"}
              </button>
            ) : (
              <span />
            )}
            <div className='flex gap-2'>
              <button
                type='button'
                onClick={onClose}
                className='rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50'>
                Cancel
              </button>
              <button
                type='submit'
                disabled={pending}
                className='flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60'>
                {save.isPending && (
                  <SpinnerGapIcon size={16} className='animate-spin' />
                )}
                Save
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}

const dateLabel = (date: string) =>
  new Date(`${date}T00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: [T, ReactNode][];
}) {
  return (
    <div className='text-sm font-medium text-stone-700'>
      {label}
      <div className='mt-1 grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-1'>
        {options.map(([v, text]) => (
          <button
            key={v}
            type='button'
            aria-pressed={value === v}
            onClick={() => onChange(v)}
            className={`rounded-md px-3 py-1.5 text-sm ${value === v ? "bg-white font-semibold text-stone-900 shadow-sm" : "text-stone-500 hover:text-stone-700"}`}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
