import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { AuthState } from '../lib/useAuth';

export type RouterContext = { auth: AuthState };

export const Route = createRootRouteWithContext<RouterContext>()({ component: Outlet });
