import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";

// Public pages
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Dashboard from "./pages/Dashboard";

// Role-specific dashboards
import TraderDashboard from "./pages/trader/TraderDashboard";
import TraderAccounts from "./pages/trader/TraderAccounts";
import TraderTrades from "./pages/trader/TraderTrades";
import TraderPayouts from "./pages/trader/TraderPayouts";
import RiskDashboard from "./pages/risk/RiskDashboard";
import ReviewQueue from "./pages/risk/ReviewQueue";
import AdminDashboard from "./pages/admin/AdminDashboard";
import SystemOverview from "./pages/admin/SystemOverview";
import UsersManagement from "./pages/admin/UsersManagement";
import CohortsManagement from "./pages/admin/CohortsManagement";
import AuditLogs from "./pages/admin/AuditLogs";
import SupportDashboard from "./pages/support/SupportDashboard";
import AccountDetails from "./pages/trader/AccountDetails";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            {/* Public routes */}
            <Route path="/" element={<Index />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />

            {/* Protected dashboard router */}
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <Dashboard />
                </ProtectedRoute>
              }
            />

            {/* Trader routes */}
            <Route
              path="/trader"
              element={
                <ProtectedRoute allowedRoles={['trader', 'admin']}>
                  <TraderDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/trader/accounts"
              element={
                <ProtectedRoute allowedRoles={['trader', 'admin']}>
                  <TraderAccounts />
                </ProtectedRoute>
              }
            />
            <Route
              path="/trader/accounts/:id"
              element={
                <ProtectedRoute allowedRoles={['trader', 'admin']}>
                  <AccountDetails />
                </ProtectedRoute>
              }
            />
            <Route
              path="/trader/trades"
              element={
                <ProtectedRoute allowedRoles={['trader', 'admin']}>
                  <TraderTrades />
                </ProtectedRoute>
              }
            />
            <Route
              path="/trader/payouts"
              element={
                <ProtectedRoute allowedRoles={['trader', 'admin']}>
                  <TraderPayouts />
                </ProtectedRoute>
              }
            />

            {/* Risk Officer routes */}
            <Route
              path="/risk"
              element={
                <ProtectedRoute allowedRoles={['risk_officer', 'admin']}>
                  <RiskDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/risk/queue"
              element={
                <ProtectedRoute allowedRoles={['risk_officer', 'admin']}>
                  <ReviewQueue />
                </ProtectedRoute>
              }
            />
            <Route
              path="/risk/*"
              element={
                <ProtectedRoute allowedRoles={['risk_officer', 'admin']}>
                  <RiskDashboard />
                </ProtectedRoute>
              }
            />

            {/* Admin routes */}
            <Route
              path="/admin"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <AdminDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/system"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <SystemOverview />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/users"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <UsersManagement />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/cohorts"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <CohortsManagement />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/audit"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <AuditLogs />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/*"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <AdminDashboard />
                </ProtectedRoute>
              }
            />

            {/* Support routes */}
            <Route
              path="/support"
              element={
                <ProtectedRoute allowedRoles={['support', 'admin']}>
                  <SupportDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/support/*"
              element={
                <ProtectedRoute allowedRoles={['support', 'admin']}>
                  <SupportDashboard />
                </ProtectedRoute>
              }
            />

            {/* Catch-all */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
