import { useState } from 'react';
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { EnvelopeSimpleIcon, LockSimpleIcon } from '@phosphor-icons/react';
import { requireSupabase } from '../lib/supabase';
import { redirectIfSignedIn, validateAuthSearch } from '../lib/authRoutes';
import { AuthLayout, ErrorBanner, Field, SubmitButton } from '../component/AuthLayout';

export const Route = createFileRoute('/login')({ validateSearch: validateAuthSearch, beforeLoad: redirectIfSignedIn, component: LoginPage });

function LoginPage() {
  const router = useRouter(), navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: async () => {
      const { error } = await requireSupabase().auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
    },
    onSuccess: async () => { await router.invalidate(); await navigate({ to: redirect ?? '/' }); },
  });
  return <AuthLayout title="Welcome back" subtitle="Log in to plan your week." footer={<>New to Weekspace? <Link to="/signup" search={{ redirect }} className="font-medium text-indigo-600 hover:underline">Create an account</Link></>}>
    <form className="space-y-4" onSubmit={e => { e.preventDefault(); login.mutate(); }}>
      <Field label="Email" icon={EnvelopeSimpleIcon} type="email" autoComplete="email" required autoFocus placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
      <Field label="Password" icon={LockSimpleIcon} type="password" autoComplete="current-password" required placeholder="Your password" value={password} onChange={e => setPassword(e.target.value)} />
      {login.error && <ErrorBanner message={login.error.message} />}
      <SubmitButton pending={login.isPending}>{login.isPending ? 'Logging in…' : 'Log in'}</SubmitButton>
    </form>
  </AuthLayout>;
}
