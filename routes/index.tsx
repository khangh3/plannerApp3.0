import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { SignOutIcon } from '@phosphor-icons/react';
import { useAuth } from '../lib/useAuth';

export const Route = createFileRoute('/')({
  beforeLoad: ({ context, location }) => { if (!context.auth.session) throw redirect({ to: '/login', search: { redirect: location.href } }); },
  component: HomePage,
});

function HomePage() {
  const { user, signOut } = useAuth(), navigate = useNavigate();
  const logout = useMutation({ mutationFn: signOut, onSuccess: () => navigate({ to: '/login' }) });
  const name = user?.user_metadata.display_name || user?.email;
  return <main className="min-h-screen bg-[#f7f7f2] px-4 py-12 text-stone-800">
    <div className="mx-auto flex max-w-3xl items-center justify-between">
      <h1 className="text-2xl font-semibold tracking-tight">Hi, {name}</h1>
      <button onClick={() => logout.mutate()} disabled={logout.isPending} className="flex items-center gap-2 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium hover:bg-stone-50 disabled:opacity-60"><SignOutIcon size={18} />Sign out</button>
    </div>
  </main>;
}
