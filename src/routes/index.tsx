import { useState } from 'react';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarDotsIcon, CaretLeftIcon, CaretRightIcon, PlusIcon, SignOutIcon, SpinnerGapIcon } from '@phosphor-icons/react';
import { useAuth } from '../lib/useAuth';
import { dayjs } from '../lib/time';
import { addDays, DATE, localMidnight, weekdayOf } from '../lib/recurrence';
import { fetchBlocks, fetchCategories, fetchTimeZone } from '../lib/timeBlocks';
import { WeekGrid } from '../component/WeekGrid';
import { TimeBlockDialog, type DialogTarget } from '../component/TimeBlockDialog';
import { ErrorBanner } from '../component/AuthLayout';
import type { Category } from '../type';

type WeekSearch = { week?: string };

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): WeekSearch =>
    typeof search.week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(search.week) && dayjs(search.week).isValid() ? { week: search.week } : {},
  beforeLoad: ({ context, location }) => { if (!context.auth.session) throw redirect({ to: '/login', search: { redirect: location.href } }); },
  component: WeekPage,
});

function WeekPage() {
  const { user, signOut } = useAuth(), navigate = useNavigate();
  const logout = useMutation({ mutationFn: signOut, onSuccess: () => navigate({ to: '/login' }) });
  const zone = useQuery({ queryKey: ['timeZone', user?.id], queryFn: () => fetchTimeZone(user!.id), enabled: Boolean(user) });
  const categories = useQuery({ queryKey: ['categories'], queryFn: fetchCategories });
  const name = user?.user_metadata.display_name || user?.email;

  return <main className="flex h-screen flex-col gap-4 bg-[#f7f7f2] px-4 py-4 text-stone-800 sm:px-6">
    <header className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2"><CalendarDotsIcon size={26} weight="duotone" className="text-indigo-500" /><span className="text-lg font-semibold tracking-tight">Weekspace</span></div>
      <div className="flex items-center gap-3">
        <span className="hidden text-sm text-stone-500 sm:inline">{name}</span>
        <button onClick={() => logout.mutate()} disabled={logout.isPending} className="flex items-center gap-2 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium hover:bg-stone-50 disabled:opacity-60"><SignOutIcon size={18} />Sign out</button>
      </div>
    </header>
    {zone.error || categories.error ? <ErrorBanner message={(zone.error ?? categories.error)!.message} />
      : zone.data && categories.data ? <Week zone={zone.data} categories={categories.data} />
      : <Loading />}
  </main>;
}

function Week({ zone, categories }: { zone: string; categories: Category[] }) {
  const { week } = Route.useSearch(), navigate = useNavigate({ from: '/' });
  const [dialog, setDialog] = useState<DialogTarget | null>(null);

  const today = dayjs().tz(zone).format(DATE), anchor = week ?? today;
  const weekStart = addDays(anchor, -weekdayOf(anchor));
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const from = localMidnight(weekStart, zone), to = localMidnight(addDays(weekStart, 7), zone);
  const blocks = useQuery({ queryKey: ['timeBlocks', weekStart, zone], queryFn: () => fetchBlocks(from, to), placeholderData: prev => prev });

  const goTo = (date?: string) => navigate({ search: date ? { week: date } : {} });
  const first = dayjs.utc(weekStart), last = dayjs.utc(days[6]);
  const label = first.month() === last.month() ? `${first.format('MMMM D')} – ${last.format('D, YYYY')}`
    : first.year() === last.year() ? `${first.format('MMM D')} – ${last.format('MMM D, YYYY')}` : `${first.format('MMM D, YYYY')} – ${last.format('MMM D, YYYY')}`;
  const nav = 'rounded-lg border border-stone-300 bg-white p-2 text-stone-600 hover:bg-stone-50';

  return <>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <button onClick={() => goTo()} className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-stone-50">Today</button>
        <button onClick={() => goTo(addDays(weekStart, -7))} aria-label="Previous week" className={nav}><CaretLeftIcon size={16} /></button>
        <button onClick={() => goTo(addDays(weekStart, 7))} aria-label="Next week" className={nav}><CaretRightIcon size={16} /></button>
        <h1 className="ml-2 text-xl font-semibold tracking-tight">{label}</h1>
        {blocks.isFetching && <SpinnerGapIcon size={16} className="animate-spin text-stone-400" />}
      </div>
      <button onClick={() => setDialog({ kind: 'create', date: weekStart <= today && today <= days[6] ? today : weekStart, start: '09:00' })}
        className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"><PlusIcon size={16} weight="bold" />New block</button>
    </div>
    {blocks.error && <ErrorBanner message={blocks.error.message} />}
    <WeekGrid days={days} zone={zone} blocks={blocks.data ?? []} categories={categories}
      onCreate={(date, start) => setDialog({ kind: 'create', date, start })}
      onSelect={occurrence => setDialog({ kind: 'edit', occurrence })} />
    {dialog && <TimeBlockDialog target={dialog} categories={categories} zone={zone} onClose={() => setDialog(null)} />}
  </>;
}

const Loading = () => <div className="flex flex-1 items-center justify-center text-stone-400"><SpinnerGapIcon size={24} className="animate-spin" /></div>;
