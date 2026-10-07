import { useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { CalendarDotsIcon, EyeIcon, EyeSlashIcon, SpinnerGapIcon, WarningCircleIcon, type Icon } from '@phosphor-icons/react';

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return <main className="min-h-screen bg-[#f7f7f2] flex items-center justify-center px-4 py-12 text-stone-800">
    <div className="w-full max-w-sm">
      <div className="mb-8 flex items-center justify-center gap-2 text-stone-900"><CalendarDotsIcon size={28} weight="duotone" className="text-indigo-500" /><span className="text-xl font-semibold tracking-tight">Weekspace</span></div>
      <section className="rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight text-stone-900">{title}</h1>
        <p className="mt-1 text-sm text-stone-500">{subtitle}</p>
        <div className="mt-6">{children}</div>
      </section>
      <p className="mt-6 text-center text-sm text-stone-500">{footer}</p>
    </div>
  </main>;
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; icon: Icon };
export function Field({ label, icon: FieldIcon, type, ...props }: FieldProps) {
  const [visible, setVisible] = useState(false);
  const isPassword = type === 'password';
  return <label className="block text-sm font-medium text-stone-700">{label}
    <span className="mt-1.5 flex items-center gap-2 rounded-lg border border-stone-300 bg-white px-3 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-100">
      <FieldIcon size={18} className="shrink-0 text-stone-400" />
      <input {...props} type={isPassword && visible ? 'text' : type} className="w-full bg-transparent py-2.5 text-stone-900 outline-none placeholder:text-stone-400" />
      {isPassword && <button type="button" className="text-stone-400 hover:text-stone-600" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(v => !v)}>{visible ? <EyeSlashIcon size={18} /> : <EyeIcon size={18} />}</button>}
    </span>
  </label>;
}

export function SubmitButton({ pending, children }: { pending: boolean; children: ReactNode }) {
  return <button type="submit" disabled={pending} className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60">
    {pending && <SpinnerGapIcon size={18} className="animate-spin" />}{children}
  </button>;
}

export function ErrorBanner({ message }: { message: string }) {
  return <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"><WarningCircleIcon size={18} className="mt-px shrink-0" />{message}</div>;
}
