export const ROLES = [
  'SUPER_ADMIN',
  'OPERATIONS_MANAGER',
  'ANALYST',
  'ENGINEER',
  'AUDITOR',
] as const

export type Role = (typeof ROLES)[number]

export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  OPERATIONS_MANAGER: 'Operations Manager',
  ANALYST: 'Analyst',
  ENGINEER: 'Engineer',
  AUDITOR: 'Auditor',
}

const ALL: Role[] = [...ROLES]
const OPS: Role[] = ['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'ENGINEER']
const INSIGHT: Role[] = ['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'ANALYST', 'AUDITOR', 'ENGINEER']

export const PERMISSIONS = {
  'dashboard:view': ALL,
  'transactions:view': ALL,
  'transactions:investigate': ALL,
  'system:view': ['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'ENGINEER', 'AUDITOR'],
  'incidents:view': ALL,
  'incidents:manage': OPS,
  'incidents:assign': ['SUPER_ADMIN', 'OPERATIONS_MANAGER'],
  'anomalies:view': INSIGHT,
  'anomalies:review': ['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'ANALYST'],
  'institutions:view': ALL,
  'analytics:view': INSIGHT,
  'reports:view': ALL,
  'reports:generate': ['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'ANALYST'],
  'reports:delete': ['SUPER_ADMIN', 'OPERATIONS_MANAGER'],
  'ai:use': ['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'ANALYST', 'ENGINEER'],
  'audit:view': ['SUPER_ADMIN', 'AUDITOR'],
  'users:manage': ['SUPER_ADMIN'],
  'settings:thresholds': ['SUPER_ADMIN'],
  'settings:security': ['SUPER_ADMIN'],
  'simulator:control': ['SUPER_ADMIN', 'ENGINEER'],
  'logs:view': ['SUPER_ADMIN', 'ENGINEER', 'AUDITOR'],
} as const

export type Permission = keyof typeof PERMISSIONS

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role)
}

export function isAuditor(role: Role): boolean {
  return role === 'AUDITOR'
}

export function formatNpr(value: number): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1_000_000_000) {
    const scaled = abs / 1_000_000_000
    const digits = scaled >= 10 ? 1 : 1
    return `${sign}Rs. ${scaled.toFixed(digits)}B`
  }
  if (abs >= 1_000_000) {
    const scaled = abs / 1_000_000
    const digits = scaled >= 10 ? 1 : 2
    return `${sign}Rs. ${trimNumber(scaled.toFixed(digits))}M`
  }
  return `${sign}Rs. ${Math.round(abs).toLocaleString('en-US')}`
}

function trimNumber(value: string): string {
  return value.replace(/\.0$/, '').replace(/(\.\d)0$/, '$1')
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (Math.abs(ms) < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

export function formatCount(value: number): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`
  if (abs >= 1_000_000) return `${sign}${trimNumber((abs / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2))}M`
  if (abs >= 10_000) return `${sign}${trimNumber((abs / 1_000).toFixed(1))}K`
  return `${sign}${Math.round(abs).toLocaleString('en-US')}`
}

export const TX_STATUSES = ['SUCCESS', 'FAILED', 'PENDING', 'CANCELLED', 'REFUNDED'] as const
export type TxStatus = (typeof TX_STATUSES)[number]

export const PAYMENT_METHODS = ['QR', 'WALLET', 'BANK_TRANSFER', 'CARD', 'MOBILE_BANKING'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  QR: 'QR',
  WALLET: 'Wallet',
  BANK_TRANSFER: 'Bank Transfer',
  CARD: 'Card',
  MOBILE_BANKING: 'Mobile Banking',
}

export const INCIDENT_STATUSES = [
  'OPEN',
  'INVESTIGATING',
  'IDENTIFIED',
  'MITIGATING',
  'RESOLVED',
  'CLOSED',
] as const
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number]

export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type Severity = (typeof SEVERITIES)[number]

export const ANOMALY_TYPES = [
  'HIGH_VALUE_SPIKE',
  'TRANSACTION_VOLUME_SPIKE',
  'REPEATED_FAILURE',
  'API_LATENCY_ANOMALY',
  'MERCHANT_ACTIVITY_ANOMALY',
  'BANK_FAILURE_SPIKE',
  'SETTLEMENT_DELAY',
  'UNUSUAL_TIME_ACTIVITY',
] as const
export type AnomalyType = (typeof ANOMALY_TYPES)[number]

export const ANOMALY_STATUSES = ['DETECTED', 'REVIEW', 'CONFIRMED', 'DISMISSED'] as const

export const SERVICE_STATUSES = ['OPERATIONAL', 'DEGRADED', 'INCIDENT', 'MAINTENANCE'] as const
export type ServiceStatus = (typeof SERVICE_STATUSES)[number]

export const FAILURE_REASONS = [
  'TIMEOUT',
  'BANK_API_ERROR',
  'INSUFFICIENT_FUNDS',
  'NETWORK_ERROR',
  'INVALID_REQUEST',
  'SERVICE_UNAVAILABLE',
  'DUPLICATE_TRANSACTION',
  'AUTHENTICATION_FAILURE',
  'SETTLEMENT_DELAY',
] as const

export const REPORT_TYPES = [
  'DAILY_OPERATIONS',
  'TRANSACTION_SUMMARY',
  'INSTITUTION_PERFORMANCE',
  'INCIDENT_REPORT',
  'ANOMALY_REPORT',
  'SYSTEM_HEALTH',
] as const
export type ReportType = (typeof REPORT_TYPES)[number]

export const REPORT_LABEL: Record<ReportType, string> = {
  DAILY_OPERATIONS: 'Daily Operations Report',
  TRANSACTION_SUMMARY: 'Transaction Summary',
  INSTITUTION_PERFORMANCE: 'Institution Performance',
  INCIDENT_REPORT: 'Incident Report',
  ANOMALY_REPORT: 'Anomaly Report',
  SYSTEM_HEALTH: 'System Health Report',
}

export interface PublicUser {
  id: string
  email: string
  name: string
  role: Role
  status: 'ACTIVE' | 'LOCKED' | 'DEACTIVATED'
  lastLoginAt: string | null
  timezone: string
  theme: 'light' | 'dark' | 'system'
  notifyIncidents: boolean
  notifyAnomalies: boolean
  notifyReports: boolean
  notifySecurity: boolean
}

export interface Page<T> {
  items: T[]
  page: number
  limit: number
  total: number
  totalPages: number
}
