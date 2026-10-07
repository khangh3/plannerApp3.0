import { useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { requireSupabase, supabase } from './supabase';
import { AuthContext } from './useAuth';

const signOut = async () => { const { error } = await requireSupabase().auth.signOut(); if (error) throw error; };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(Boolean(supabase));
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); setLoading(false); });
    return () => data.subscription.unsubscribe();
  }, []);
  return <AuthContext value={{ session, user: session?.user ?? null, loading, signOut }}>{children}</AuthContext>;
}
