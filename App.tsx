import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { AuthProvider } from "./lib/auth";
import { useAuth } from "./lib/useAuth";
import { supabase } from "./lib/supabase";
import { router } from "./router";

const queryClient = new QueryClient();

function AppRouter() {
  const auth = useAuth();
  // Re-run route guards whenever the session changes (sign in/out, token refresh, other tabs).
  useEffect(() => {
    if (!auth.loading) void router.invalidate();
  }, [auth.session, auth.loading]);
  if (!supabase)
    return (
      <p className='p-8 text-red-700'>
        Supabase is not configured. Set VITE_SUPABASE_URL and
        VITE_SUPABASE_ANON_KEY in .env.local.
      </p>
    );
  if (auth.loading) return null;
  return <RouterProvider router={router} context={{ auth }} />;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <AppRouter />
    </AuthProvider>
  </QueryClientProvider>
);
export default App;
