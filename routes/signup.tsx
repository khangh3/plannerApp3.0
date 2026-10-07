import { useState } from 'react';
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { CheckCircleIcon, EnvelopeSimpleIcon, LockSimpleIcon, UserIcon } from '@phosphor-icons/react';
import { requireSupabase } from '../lib/supabase';
import { redirectIfSignedIn, validateAuthSearch } from '../lib/authRoutes';
import { AuthLayout, ErrorBanner, Field, SubmitButton } from '../component/AuthLayout';

const MIN_PASSWORD = 6; // matches auth.minimum_password_length in supabase/config.toml

export const Route = createFileRoute('/signup')({ validateSearch: validateAuthSearch, beforeLoad: redirectIfSignedIn, component: SignupPage });

function SignupPage() {
  const router = useRouter(), navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const [name, setName] = useState(''), [email, setEmail] = useState('');
  const [password, setPassword] = useState(''), [confirm, setConfirm] = useState('');
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const signup = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error('Tell us what to call you.');
      if (password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
      if (password !== confirm) throw new Error('Passwords do not match.');
      const { data, error } = await requireSupabase().auth.signUp({
        email: email.trim(), password,
        // Read by the handle_new_user trigger to create the profile.
        options: { data: { display_name: name.trim(), time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone } },
      });
      if (error) throw error;
      return data.session;
    },
    onSuccess: async session => {
      if (!session) { setAwaitingConfirmation(true); return; }
      await router.invalidate(); await navigate({ to: redirect ?? '/' });
    },
  });
  const footer = <>Already have an account? <Link to="/login" search={{ redirect }} className="font-medium text-indigo-600 hover:underline">Log in</Link></>;
  if (awaitingConfirmation) return <AuthLayout title="Check your email" subtitle={`We sent a confirmation link to ${email.trim()}.`} footer={footer}>
    <div className="flex items-center gap-2 text-sm text-stone-600"><CheckCircleIcon size={20} className="text-teal-500" />Confirm your address, then log in.</div>
  </AuthLayout>;
  return <AuthLayout title="Create your account" subtitle="Start making time for what matters." footer={footer}>
    <form className="space-y-4" onSubmit={e => { e.preventDefault(); signup.mutate(); }}>
      <Field label="Name" icon={UserIcon} autoComplete="name" required autoFocus maxLength={80} placeholder="What should we call you?" value={name} onChange={e => setName(e.target.value)} />
      <Field label="Email" icon={EnvelopeSimpleIcon} type="email" autoComplete="email" required placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
      <Field label="Password" icon={LockSimpleIcon} type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} placeholder={`At least ${MIN_PASSWORD} characters`} value={password} onChange={e => setPassword(e.target.value)} />
      <Field label="Confirm password" icon={LockSimpleIcon} type="password" autoComplete="new-password" required placeholder="Repeat your password" value={confirm} onChange={e => setConfirm(e.target.value)} />
      {signup.error && <ErrorBanner message={signup.error.message} />}
      <SubmitButton pending={signup.isPending}>{signup.isPending ? 'Creating account…' : 'Sign up'}</SubmitButton>
    </form>
  </AuthLayout>;
}
