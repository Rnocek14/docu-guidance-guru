import { ReactNode, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import {
  Shield,
  LayoutDashboard,
  TrendingUp,
  AlertTriangle,
  Users,
  Settings,
  LogOut,
  Menu,
  X,
  FileText,
  Flag,
  CreditCard,
  Activity,
} from 'lucide-react';

interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
}

interface DashboardLayoutProps {
  children: ReactNode;
  title: string;
  navItems: NavItem[];
}

export function DashboardLayout({ children, title, navItems }: DashboardLayoutProps) {
  const { profile, roles, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  const getInitials = (name: string | null | undefined) => {
    if (!name) return 'U';
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const getRoleBadge = () => {
    if (roles.includes('admin')) return 'Admin';
    if (roles.includes('risk_officer')) return 'Risk Officer';
    if (roles.includes('support')) return 'Support';
    return 'Trader';
  };

  return (
    <div className="min-h-screen bg-background flex">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 bg-sidebar-background border-r border-sidebar-border transform transition-transform duration-200 ease-in-out lg:translate-x-0 lg:static',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center justify-between h-16 px-4 border-b border-sidebar-border">
            <Link to="/dashboard" className="flex items-center gap-2">
              <Shield className="h-8 w-8 text-sidebar-primary" />
              <span className="font-bold text-sidebar-foreground">RiskAnalytics</span>
            </Link>
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setSidebarOpen(false)}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
            {navItems.map((item) => {
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  onClick={() => setSidebarOpen(false)}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                  )}
                >
                  {item.icon}
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* User section */}
          <div className="p-4 border-t border-sidebar-border">
            <div className="flex items-center gap-3">
              <Avatar className="h-10 w-10">
                <AvatarFallback className="bg-sidebar-primary text-sidebar-primary-foreground">
                  {getInitials(profile?.full_name)}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-sidebar-foreground truncate">
                  {profile?.full_name || 'User'}
                </p>
                <p className="text-xs text-muted-foreground">{getRoleBadge()}</p>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-16 border-b border-border bg-card flex items-center justify-between px-4 lg:px-6">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </Button>
            <h1 className="text-xl font-semibold">{title}</h1>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="relative h-10 w-10 rounded-full">
                <Avatar className="h-10 w-10">
                  <AvatarFallback>{getInitials(profile?.full_name)}</AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium">{profile?.full_name || 'User'}</p>
                  <p className="text-xs text-muted-foreground">{profile?.email}</p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleSignOut} className="text-destructive">
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/* Page content */}
        <main className="flex-1 p-4 lg:p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

// Pre-built nav configurations for each role
export const traderNavItems: NavItem[] = [
  { label: 'Dashboard', href: '/trader', icon: <LayoutDashboard className="h-5 w-5" /> },
  { label: 'Accounts', href: '/trader/accounts', icon: <TrendingUp className="h-5 w-5" /> },
  { label: 'Trades', href: '/trader/trades', icon: <Activity className="h-5 w-5" /> },
  { label: 'Payouts', href: '/trader/payouts', icon: <CreditCard className="h-5 w-5" /> },
];

export const riskNavItems: NavItem[] = [
  { label: 'Dashboard', href: '/risk', icon: <LayoutDashboard className="h-5 w-5" /> },
  { label: 'Accounts', href: '/risk/accounts', icon: <Users className="h-5 w-5" /> },
  { label: 'Flags', href: '/risk/flags', icon: <Flag className="h-5 w-5" /> },
  { label: 'Violations', href: '/risk/violations', icon: <AlertTriangle className="h-5 w-5" /> },
  { label: 'Audit Logs', href: '/risk/audit', icon: <FileText className="h-5 w-5" /> },
];

export const adminNavItems: NavItem[] = [
  { label: 'Dashboard', href: '/admin', icon: <LayoutDashboard className="h-5 w-5" /> },
  { label: 'Users', href: '/admin/users', icon: <Users className="h-5 w-5" /> },
  { label: 'Cohorts', href: '/admin/cohorts', icon: <Settings className="h-5 w-5" /> },
  { label: 'Payouts', href: '/admin/payouts', icon: <CreditCard className="h-5 w-5" /> },
  { label: 'Flags', href: '/admin/flags', icon: <Flag className="h-5 w-5" /> },
  { label: 'Audit Logs', href: '/admin/audit', icon: <FileText className="h-5 w-5" /> },
  { label: 'System', href: '/admin/system', icon: <Settings className="h-5 w-5" /> },
];

export const supportNavItems: NavItem[] = [
  { label: 'Dashboard', href: '/support', icon: <LayoutDashboard className="h-5 w-5" /> },
  { label: 'Accounts', href: '/support/accounts', icon: <Users className="h-5 w-5" /> },
  { label: 'Payouts', href: '/support/payouts', icon: <CreditCard className="h-5 w-5" /> },
];
