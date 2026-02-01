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
import RiskDashboard from "./pages/risk/RiskDashboard";
import AdminDashboard from "./pages/admin/AdminDashboard";
import SupportDashboard from "./pages/support/SupportDashboard";

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
              path="/trader/*"
              element={
                <ProtectedRoute allowedRoles={['trader', 'admin']}>
                  <TraderDashboard />
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
