import { useEffect, useRef, type MouseEvent } from 'react';
import { ArrowsClockwiseIcon } from '@phosphor-icons/react';
import { dayjs } from '../lib/time';
import { addDays, DATE, daySegment, layoutLanes, localMidnight, occurrences, type Occurrence, type Segment } from '../lib/recurrence';
import type { PlannerBlock } from '../lib/timeBlocks';
import type { Category } from '../type';

const HOUR_PX = 48;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const GRID_COLS = 'grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]';

type Props = {
  days: string[]; zone: string; blocks: PlannerBlock[]; categories: Category[];
  onCreate: (date: string, start: string) => void; onSelect: (occurrence: Occurrence) => void;
};

export function WeekGrid({ days, zone, blocks, categories, onCreate, onSelect }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 7 * HOUR_PX }); }, []);

  const now = dayjs(), today = now.tz(zone).format(DATE);
  const colors = new Map(categories.map(c => [c.id, c.color]));
  const columns = days.map(date => {
    const dayStart = localMidnight(date, zone), dayEnd = localMidnight(addDays(date, 1), zone);
    const segments = blocks.flatMap(b => occurrences(b, b.exceptions, dayStart, dayEnd))
      .map(o => daySegment(o, dayStart, dayEnd)).filter((s): s is Segment => s !== null);
    return { date, dayStart, segments: layoutLanes(segments) };
  });

  const createAt = (date: string) => (e: MouseEvent<HTMLDivElement>) => {
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    const minutes = Math.min(Math.floor((y / HOUR_PX) * 2) * 30, 23 * 60 + 30);
    onCreate(date, `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
  };

  return <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
    <div className="min-w-[720px]">
      <div className={`sticky top-0 z-20 grid ${GRID_COLS} border-b border-stone-200 bg-white`}>
        <div className="py-2 text-center text-[10px] text-stone-400">{now.tz(zone).format('z')}</div>
        {days.map(date => {
          const d = dayjs.utc(date), isToday = date === today;
          return <div key={date} className="border-l border-stone-100 py-2 text-center">
            <div className={`text-xs font-medium uppercase tracking-wide ${isToday ? 'text-indigo-600' : 'text-stone-500'}`}>{d.format('ddd')}</div>
            <div className={`mx-auto mt-0.5 flex size-8 items-center justify-center rounded-full text-lg font-semibold ${isToday ? 'bg-indigo-600 text-white' : 'text-stone-800'}`}>{d.format('D')}</div>
          </div>;
        })}
      </div>

      <div className={`relative grid ${GRID_COLS}`} style={{ height: 24 * HOUR_PX }}>
        <div className="relative">
          {HOURS.slice(1).map(h => <span key={h} className="absolute right-2 -translate-y-1/2 text-[11px] text-stone-400" style={{ top: h * HOUR_PX }}>{dayjs().hour(h).format('h A')}</span>)}
        </div>
        {columns.map(({ date, dayStart, segments }) => <div key={date} onClick={createAt(date)} className={`relative cursor-cell border-l border-stone-100 ${date === today ? 'bg-indigo-50/30' : ''}`}>
          {HOURS.slice(1).map(h => <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-stone-100" style={{ top: h * HOUR_PX }} />)}
          {segments.map(s => <BlockChip key={`${s.block.id}-${s.start.valueOf()}`} segment={s} zone={zone} color={colors.get(s.block.categoryId) ?? '#78716c'} onSelect={onSelect} />)}
          {date === today && <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500" style={{ top: (now.diff(dayStart, 'minute') / 60) * HOUR_PX }}>
            <span className="absolute -left-1 -top-[5px] size-2 rounded-full bg-red-500" />
          </div>}
        </div>)}
      </div>
    </div>
  </div>;
}

function BlockChip({ segment: s, zone, color, onSelect }: { segment: Segment & { lane: number; lanes: number }; zone: string; color: string; onSelect: (o: Occurrence) => void }) {
  const top = (s.top / 60) * HOUR_PX, height = Math.max(((Math.min(s.bottom, 1440) - s.top) / 60) * HOUR_PX - 2, 18);
  const flexible = s.block.availability === 'flexible';
  const time = (t: dayjs.Dayjs) => t.tz(zone).format('h:mm A');
  return <button type="button" onClick={e => { e.stopPropagation(); onSelect(s); }}
    title={`${s.block.title}\n${time(s.start)} – ${time(s.end)}${flexible ? ' (flexible)' : ''}`}
    className={`absolute z-[1] overflow-hidden px-1.5 py-0.5 text-left text-xs text-stone-800 hover:z-[2] hover:shadow-md focus-visible:z-[2] focus-visible:outline-2 focus-visible:outline-indigo-500
      ${s.continuesBefore ? 'rounded-t-none' : 'rounded-t-md'} ${s.continuesAfter ? 'rounded-b-none' : 'rounded-b-md'}
      ${flexible ? 'border border-dashed' : 'border-l-4'}`}
    style={{ top, height, left: `calc(${(s.lane / s.lanes) * 100}% + 2px)`, width: `calc(${100 / s.lanes}% - 4px)`, borderColor: color, backgroundColor: `${color}${flexible ? '14' : '29'}` }}>
    <div className="flex items-center gap-1 font-semibold">
      <span className="truncate">{s.block.title}</span>
      {s.block.recurringStartDate && <ArrowsClockwiseIcon size={11} className="shrink-0 text-stone-500" aria-label="Repeats" />}
    </div>
    {height > 30 && <div className="truncate text-[11px] text-stone-600">{time(s.start)} – {time(s.end)}</div>}
  </button>;
}
