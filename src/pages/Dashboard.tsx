import { useAuth } from '@/contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

export default function Dashboard() {
  const { roles, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  // Redirect based on highest priority role
  if (roles.includes('admin')) {
    return <Navigate to="/admin" replace />;
  }
  
  if (roles.includes('risk_officer')) {
    return <Navigate to="/risk" replace />;
  }
  
  if (roles.includes('support')) {
    return <Navigate to="/support" replace />;
  }

  if (roles.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-2xl font-semibold text-foreground">Access is still being set up</h1>
          <p className="text-muted-foreground">
            Your account is signed in, but no platform role is available yet. Refresh once; if this remains, assign a role in Admin Users.
          </p>
        </div>
      </div>
    );
  }
  
  // Default: trader dashboard
  return <Navigate to="/trader" replace />;
}
