import { redirect } from '@tanstack/react-router';
import type { AuthState } from './useAuth';

export type AuthSearch = { redirect?: string };

// Only accept same-origin paths so the redirect param cannot send users off-site.
export const validateAuthSearch = (search: Record<string, unknown>): AuthSearch =>
  typeof search.redirect === 'string' && search.redirect.startsWith('/') && !search.redirect.startsWith('//') ? { redirect: search.redirect } : {};

export const redirectIfSignedIn = ({ context }: { context: { auth: AuthState } }) => { if (context.auth.session) throw redirect({ to: '/' }); };
