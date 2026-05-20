import { ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout, traderNavItems } from './DashboardLayout';

interface AuthAwareShellProps {
  title: string;
  /** Rendered when user is signed out (own header, etc.) */
  standalone: ReactNode;
  /** Rendered inside DashboardLayout when user is signed in */
  authed: ReactNode;
}

/**
 * Renders standalone public chrome for anonymous visitors,
 * and embeds inside the trader DashboardLayout (sidebar) for signed-in users
 * so navigating to public pages from inside the app feels cohesive.
 */
export function AuthAwareShell({ title, standalone, authed }: AuthAwareShellProps) {
  const { user, isLoading } = useAuth();
  if (isLoading) return null;
  if (user) {
    return (
      <DashboardLayout title={title} navItems={traderNavItems}>
        {authed}
      </DashboardLayout>
    );
  }
  return <>{standalone}</>;
}