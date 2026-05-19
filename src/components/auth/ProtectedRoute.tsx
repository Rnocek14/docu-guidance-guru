import { Navigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import type { AppRole } from '@/lib/types';
import { Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles?: AppRole[];
}

export function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { user, roles, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // If specific roles are required, check them. Render an explicit
  // unauthorized screen instead of redirecting — a blind redirect to
  // /dashboard can loop when the user has no compatible role for
  // either route, and silently hides why access was denied.
  if (allowedRoles && allowedRoles.length > 0) {
    const hasAllowedRole = allowedRoles.some((role) => roles.includes(role));
    if (!hasAllowedRole) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-6">
          <div className="max-w-md w-full text-center space-y-4">
            <ShieldAlert className="h-10 w-10 text-muted-foreground mx-auto" />
            <h1 className="text-2xl font-semibold text-foreground">Not authorized</h1>
            <p className="text-sm text-muted-foreground">
              Your account doesn't have access to this area. If you think this is a mistake, contact support.
            </p>
            <div className="flex gap-2 justify-center pt-2">
              <Button asChild variant="outline">
                <Link to="/">Home</Link>
              </Button>
              <Button asChild>
                <Link to="/dashboard">Go to dashboard</Link>
              </Button>
            </div>
          </div>
        </div>
      );
    }
  }

  return <>{children}</>;
}
