import { lazy, Suspense, type ComponentType, type ReactElement } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { can, type Permission } from '@finopsx/shared'
import { AppShell } from './components/shell'
import { useAuth } from './contexts'
import { Skeleton } from './components/ui'
import { LandingPage } from './pages/Landing'
import { ForgotPage, LoginPage, ResetPage } from './pages/AuthPages'
import { AccessDenied, NotFound } from './pages/States'

function page<M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M & string) {
  return lazy(() => load().then((module) => ({ default: module[name] as ComponentType })))
}

const pages = {
  dashboard: () => import('./pages/Dashboard'),
  transactions: () => import('./pages/Transactions'),
  operations: () => import('./pages/Operations'),
  system: () => import('./pages/SystemHealth'),
  incidents: () => import('./pages/Incidents'),
  analytics: () => import('./pages/Analytics'),
  reports: () => import('./pages/Reports'),
  assistant: () => import('./pages/Assistant'),
  ops: () => import('./pages/OpsModules'),
  platform: () => import('./pages/Platform'),
  admin: () => import('./pages/Admin'),
}

const DashboardPage = page(pages.dashboard, 'DashboardPage')
const TransactionsPage = page(pages.transactions, 'TransactionsPage')
const TransactionDetailPage = page(pages.transactions, 'TransactionDetailPage')
const InstitutionsPage = page(pages.operations, 'InstitutionsPage')
const InstitutionDetailPage = page(pages.operations, 'InstitutionDetailPage')
const AnomaliesPage = page(pages.operations, 'AnomaliesPage')
const SystemHealthPage = page(pages.system, 'SystemHealthPage')
const ApiDetailPage = page(pages.system, 'ApiDetailPage')
const IncidentsPage = page(pages.incidents, 'IncidentsPage')
const IncidentDetailPage = page(pages.incidents, 'IncidentDetailPage')
const AnalyticsPage = page(pages.analytics, 'AnalyticsPage')
const MerchantsPage = page(pages.analytics, 'MerchantsPage')
const ReportsPage = page(pages.reports, 'ReportsPage')
const ReportDetailPage = page(pages.reports, 'ReportDetailPage')
const AssistantPage = page(pages.assistant, 'AssistantPage')
const ReconciliationPage = page(pages.ops, 'ReconciliationPage')
const JobsPage = page(pages.ops, 'JobsPage')
const DataQualityPage = page(pages.ops, 'DataQualityPage')
const ServiceMapPage = page(pages.platform, 'ServiceMapPage')
const DemoSimulatorPage = page(pages.platform, 'DemoSimulatorPage')
const AuditPage = page(pages.admin, 'AuditPage')
const UsersPage = page(pages.admin, 'UsersPage')
const NotificationsPage = page(pages.admin, 'NotificationsPage')
const SettingsPage = page(pages.admin, 'SettingsPage')
const ProfilePage = page(pages.admin, 'ProfilePage')

function Guard({ permission, children }: { permission?: Permission; children: ReactElement }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="grid min-h-screen place-items-center"><Skeleton className="h-24 w-64" /></div>
  if (!user) return <Navigate to="/login" replace />
  if (permission && !can(user.role, permission)) return <AccessDenied />
  return <Suspense fallback={<div className="space-y-3" aria-busy="true"><Skeleton className="h-10 w-64" /><Skeleton className="h-72" /></div>}>{children}</Suspense>
}

const ROUTES: Array<[string, Permission | undefined, ReactElement]> = [
  ['/dashboard', 'dashboard:view', <DashboardPage />],
  ['/transactions', 'transactions:view', <TransactionsPage />],
  ['/transactions/:id', 'transactions:view', <TransactionDetailPage />],
  ['/system-health', 'system:view', <SystemHealthPage />],
  ['/system-health/apis/:id', 'apis:view', <ApiDetailPage />],
  ['/incidents', 'incidents:view', <IncidentsPage />],
  ['/incidents/:id', 'incidents:view', <IncidentDetailPage />],
  ['/institutions', 'institutions:view', <InstitutionsPage />],
  ['/institutions/:id', 'institutions:view', <InstitutionDetailPage />],
  ['/anomalies', 'anomalies:view', <AnomaliesPage />],
  ['/analytics', 'analytics:view', <AnalyticsPage />],
  ['/analytics/merchants', 'analytics:view', <MerchantsPage />],
  ['/ai-assistant', 'ai:use', <AssistantPage />],
  ['/reports', 'reports:view', <ReportsPage />],
  ['/reports/:id', 'reports:view', <ReportDetailPage />],
  ['/notifications', undefined, <NotificationsPage />],
  ['/audit-logs', 'audit:view', <AuditPage />],
  ['/users', 'users:manage', <UsersPage />],
  ['/jobs', 'jobs:view', <JobsPage />],
  ['/reconciliation', 'reconciliation:view', <ReconciliationPage />],
  ['/data-quality', 'dataquality:view', <DataQualityPage />],
  ['/service-map', 'services:view', <ServiceMapPage />],
  ['/demo-simulator', 'simulator:control', <DemoSimulatorPage />],
  ['/settings', undefined, <SettingsPage />],
  ['/profile', undefined, <ProfilePage />],
]

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPage />} />
      <Route path="/reset-password" element={<ResetPage />} />
      <Route element={<Guard><AppShell /></Guard>}>
        {ROUTES.map(([path, permission, element]) => <Route key={path} path={path} element={<Guard permission={permission}>{element}</Guard>} />)}
        <Route path="/overview" element={<Navigate to="/dashboard" replace />} />
        <Route path="/ask-data" element={<Navigate to="/ai-assistant?tab=ask-data" replace />} />
        <Route path="/simulator" element={<Navigate to="/demo-simulator" replace />} />
        <Route path="/access-denied" element={<AccessDenied />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
