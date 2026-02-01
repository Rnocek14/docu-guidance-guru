import { useAuth } from '@/contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

export default function Dashboard() {
  const { roles, isLoading, profile } = useAuth();

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
  
  // Default: trader dashboard
  return <Navigate to="/trader" replace />;
}
