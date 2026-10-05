import type { ReactElement } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { can, type Permission } from '@finopsx/shared'
import { AppShell } from './components/shell'
import { useAuth } from './contexts'
import { Skeleton } from './components/ui'
import { LandingPage } from './pages/Landing'
import { ForgotPage, LoginPage, ResetPage } from './pages/AuthPages'
import { DashboardPage } from './pages/Dashboard'
import { TransactionDetailPage, TransactionsPage } from './pages/Transactions'
import { AnomaliesPage, IncidentDetailPage, IncidentsPage, InstitutionDetailPage, InstitutionsPage, SystemHealthPage } from './pages/Operations'
import { AnalyticsPage, MerchantsPage } from './pages/Analytics'
import { ReportsPage } from './pages/Reports'
import { AssistantPage } from './pages/Assistant'
import { AuditPage, ProfilePage, SettingsPage, UsersPage } from './pages/Admin'
import { AccessDenied, NotFound } from './pages/States'

function Guard({ permission, children }: { permission?: Permission; children: ReactElement }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="grid min-h-screen place-items-center"><Skeleton className="h-24 w-64" /></div>
  if (!user) return <Navigate to="/login" replace />
  if (permission && !can(user.role, permission)) return <AccessDenied />
  return children
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPage />} />
      <Route path="/reset-password" element={<ResetPage />} />
      <Route element={<Guard><AppShell /></Guard>}>
        <Route path="/dashboard" element={<Guard permission="dashboard:view"><DashboardPage /></Guard>} />
        <Route path="/transactions" element={<Guard permission="transactions:view"><TransactionsPage /></Guard>} />
        <Route path="/transactions/:id" element={<Guard permission="transactions:view"><TransactionDetailPage /></Guard>} />
        <Route path="/system-health" element={<Guard permission="system:view"><SystemHealthPage /></Guard>} />
        <Route path="/incidents" element={<Guard permission="incidents:view"><IncidentsPage /></Guard>} />
        <Route path="/incidents/:id" element={<Guard permission="incidents:view"><IncidentDetailPage /></Guard>} />
        <Route path="/institutions" element={<Guard permission="institutions:view"><InstitutionsPage /></Guard>} />
        <Route path="/institutions/:id" element={<Guard permission="institutions:view"><InstitutionDetailPage /></Guard>} />
        <Route path="/anomalies" element={<Guard permission="anomalies:view"><AnomaliesPage /></Guard>} />
        <Route path="/analytics" element={<Guard permission="analytics:view"><AnalyticsPage /></Guard>} />
        <Route path="/analytics/merchants" element={<Guard permission="analytics:view"><MerchantsPage /></Guard>} />
        <Route path="/reports" element={<Guard permission="reports:view"><ReportsPage /></Guard>} />
        <Route path="/ai-assistant" element={<Guard permission="ai:use"><AssistantPage /></Guard>} />
        <Route path="/audit-logs" element={<Guard permission="audit:view"><AuditPage /></Guard>} />
        <Route path="/users" element={<Guard permission="users:manage"><UsersPage /></Guard>} />
        <Route path="/settings" element={<Guard><SettingsPage /></Guard>} />
        <Route path="/profile" element={<Guard><ProfilePage /></Guard>} />
        <Route path="/access-denied" element={<AccessDenied />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
