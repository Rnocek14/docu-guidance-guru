import { Suspense, lazy } from "react";
import { useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/contexts/AuthContext";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { ScrollToHash } from "@/components/ScrollToHash";
import { Loader2 } from "lucide-react";
import { captureReferralFromUrl } from "@/lib/referral";

// Lazy-loaded pages
const Index = lazy(() => import("./pages/Index"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Login = lazy(() => import("./pages/Login"));
const Signup = lazy(() => import("./pages/Signup"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Checkout = lazy(() => import("./pages/Checkout"));
const Rules = lazy(() => import("./pages/Rules"));
const PublicPayoutShare = lazy(() => import("./pages/PublicPayoutShare"));
const PayoutWall = lazy(() => import("./pages/PayoutWall"));

const TraderDashboard = lazy(() => import("./pages/trader/TraderDashboard"));
const TraderAccounts = lazy(() => import("./pages/trader/TraderAccounts"));
const TraderTrades = lazy(() => import("./pages/trader/TraderTrades"));
const TraderPayouts = lazy(() => import("./pages/trader/TraderPayouts"));
const PayoutRequest = lazy(() => import("./pages/trader/PayoutRequest"));
const AccountDetails = lazy(() => import("./pages/trader/AccountDetails"));
const ResetCheckout = lazy(() => import("./pages/ResetCheckout"));

const RiskDashboard = lazy(() => import("./pages/risk/RiskDashboard"));
const ReviewQueue = lazy(() => import("./pages/risk/ReviewQueue"));

const MissionControl = lazy(() => import("./pages/admin/MissionControl"));
const AdminDashboard = lazy(() => import("./pages/admin/AdminDashboard"));
const SystemOverview = lazy(() => import("./pages/admin/SystemOverview"));
const UsersManagement = lazy(() => import("./pages/admin/UsersManagement"));
const CohortsManagement = lazy(() => import("./pages/admin/CohortsManagement"));
const AuditLogs = lazy(() => import("./pages/admin/AuditLogs"));
const MonteCarloAnalytics = lazy(() => import("./pages/admin/MonteCarloAnalytics"));
const LiabilityDashboard = lazy(() => import("./pages/admin/LiabilityDashboard"));
const OpsPlaybook = lazy(() => import("./pages/admin/OpsPlaybook"));
const OpsMetrics = lazy(() => import("./pages/admin/OpsMetrics"));
const TierReadiness = lazy(() => import("./pages/admin/TierReadiness"));
const AdminReadiness = lazy(() => import("./pages/admin/AdminReadiness"));
const GovernorDashboard = lazy(() => import("./pages/admin/GovernorDashboard"));
const QaScanRunner = lazy(() => import("./pages/admin/QaScanRunner"));
const SupportEmails = lazy(() => import("./pages/admin/SupportEmails"));
const WealthChartsIntegration = lazy(() => import("./pages/admin/WealthChartsIntegration"));
const CohortProjection = lazy(() => import("./pages/admin/CohortProjection"));
const ShareBonusQueue = lazy(() => import("./pages/admin/ShareBonusQueue"));
const SupportDashboard = lazy(() => import("./pages/support/SupportDashboard"));
const AffiliateApply = lazy(() => import("./pages/affiliate/AffiliateApply"));
const AffiliateDashboard = lazy(() => import("./pages/affiliate/AffiliateDashboard"));
const AffiliateAdmin = lazy(() => import("./pages/admin/AffiliateAdmin"));

function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

const queryClient = new QueryClient();

function ReferralCapture() {
  useEffect(() => { captureReferralFromUrl(); }, []);
  return null;
}

const App = () => (
  <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <ScrollToHash />
          <ReferralCapture />
          <Suspense fallback={<PageLoader />}>
          <Routes>
            {/* Public routes */}
            <Route path="/" element={<Index />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/checkout" element={<Checkout />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/p/:shortId" element={<PublicPayoutShare />} />
            <Route path="/payouts" element={<PayoutWall />} />

            {/* Affiliate */}
            <Route
              path="/affiliate/apply"
              element={
                <ProtectedRoute>
                  <AffiliateApply />
                </ProtectedRoute>
              }
            />
            <Route
              path="/affiliate/dashboard"
              element={
                <ProtectedRoute>
                  <AffiliateDashboard />
                </ProtectedRoute>
              }
            />

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
              path="/trader/accounts/:id/payout"
              element={
                <ProtectedRoute allowedRoles={['trader', 'admin']}>
                  <PayoutRequest />
                </ProtectedRoute>
              }
            />
            <Route
              path="/reset/:accountId"
              element={
                <ProtectedRoute allowedRoles={['trader', 'admin']}>
                  <ResetCheckout />
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
                  <MissionControl />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/overview"
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
              path="/admin/monte-carlo"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <MonteCarloAnalytics />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/liability"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <LiabilityDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/ops-playbook"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <OpsPlaybook />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/ops-metrics"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <OpsMetrics />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/tier-readiness"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <TierReadiness />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/readiness"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <AdminReadiness />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/governor"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <GovernorDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/qa-scan"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <QaScanRunner />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/support-emails"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <SupportEmails />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/wealthcharts"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <WealthChartsIntegration />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/projection"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <CohortProjection />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/share-bonuses"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <ShareBonusQueue />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/affiliates"
              element={
                <ProtectedRoute allowedRoles={['admin']}>
                  <AffiliateAdmin />
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
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
  </ThemeProvider>
);

export default App;