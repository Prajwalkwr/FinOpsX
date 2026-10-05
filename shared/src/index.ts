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
const SA = 'SUPER_ADMIN' as const
const OPS = 'OPERATIONS_MANAGER' as const
const ENG = 'ENGINEER' as const
const ANL = 'ANALYST' as const
const AUD = 'AUDITOR' as const

/**
 * Backend-enforced permission matrix. Every protected API route checks one of these keys.
 * AUDITOR receives read-only (`:view`) keys and never a mutating key.
 */
export const PERMISSIONS = {
  'dashboard:view': ALL,
  'notifications:view': ALL,
  'transactions:view': [SA, OPS, ANL, AUD],
  'transactions:investigate': [SA, OPS, ANL],
  'institutions:view': [SA, OPS, AUD],
  'incidents:view': [SA, OPS, ENG, AUD],
  'incidents:manage': [SA, OPS, ENG],
  'incidents:assign': [SA, OPS],
  'anomalies:view': [SA, ANL, AUD],
  'anomalies:review': [SA, ANL],
  'analytics:view': [SA, OPS, ANL, AUD],
  'reports:view': [SA, OPS, ANL, AUD],
  'reports:generate': [SA, OPS, ANL],
  'reports:delete': [SA, OPS],
  'system:view': [SA, ENG, AUD],
  'apis:view': [SA, ENG, AUD],
  'services:view': [SA, ENG, AUD],
  'reconciliation:view': [SA, OPS, AUD],
  'reconciliation:run': [SA, OPS],
  'jobs:view': [SA, OPS, ENG, AUD],
  'jobs:run': [SA, OPS, ENG],
  'dataquality:view': [SA, OPS, ANL, ENG, AUD],
  'dataquality:manage': [SA, ANL, ENG],
  'ai:use': [SA, OPS, ANL, ENG],
  'askdata:use': [SA, OPS, ANL],
  'audit:view': [SA, AUD],
  'users:manage': [SA],
  'settings:thresholds': [SA],
  'settings:security': [SA],
  'simulator:control': [SA, ENG],
} as const satisfies Record<string, readonly Role[]>

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
  if (abs >= 1_000_000_000) return `${sign}Rs. ${(abs / 1_000_000_000).toFixed(1)}B`
  if (abs >= 1_000_000) {
    const scaled = abs / 1_000_000
    return `${sign}Rs. ${trimNumber(scaled.toFixed(scaled >= 10 ? 1 : 2))}M`
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

export const TX_STATUSES = ['INITIATED', 'PROCESSING', 'SUCCESS', 'FAILED', 'PENDING', 'REVERSED', 'SETTLED', 'CANCELLED', 'REFUNDED'] as const
export type TxStatus = (typeof TX_STATUSES)[number]

/** Statuses that count as a successful payment in every metric (dashboard, analytics, reports, AI). */
export const SUCCESS_STATUSES = ['SUCCESS', 'SETTLED'] as const satisfies readonly TxStatus[]

export function isSuccessStatus(status: string): boolean {
  return (SUCCESS_STATUSES as readonly string[]).includes(status)
}

export const LIFECYCLE_STAGES = ['INITIATED', 'AUTHENTICATING', 'PROCESSING', 'OUTCOME', 'SETTLEMENT', 'COMPLETED'] as const
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number]

export const PAYMENT_METHODS = ['QR', 'WALLET', 'BANK_TRANSFER', 'CARD', 'ACCOUNT_PAYMENT'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  QR: 'QR',
  WALLET: 'Wallet',
  BANK_TRANSFER: 'Bank Transfer',
  CARD: 'Card',
  ACCOUNT_PAYMENT: 'Account Payment',
}

export const INCIDENT_STATUSES = [
  'DETECTED',
  'ACKNOWLEDGED',
  'INVESTIGATING',
  'IDENTIFIED',
  'MITIGATING',
  'RESOLVED',
  'POST_INCIDENT_REVIEW',
] as const
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number]
export const ACTIVE_INCIDENT_STATUSES = ['DETECTED', 'ACKNOWLEDGED', 'INVESTIGATING', 'IDENTIFIED', 'MITIGATING'] as const satisfies readonly IncidentStatus[]

export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type Severity = (typeof SEVERITIES)[number]

export const ANOMALY_TYPES = [
  'HIGH_VALUE_SPIKE',
  'FAILURE_RATE_SPIKE',
  'API_LATENCY_SPIKE',
  'REPEATED_FAILURE',
  'MERCHANT_VOLUME_SPIKE',
  'INSTITUTION_ACTIVITY',
  'SETTLEMENT_DELAY',
  'TRANSACTION_VOLUME_SPIKE',
  'UNUSUAL_TIME_ACTIVITY',
] as const
export type AnomalyType = (typeof ANOMALY_TYPES)[number]

export const ANOMALY_LABEL: Record<AnomalyType, string> = {
  HIGH_VALUE_SPIKE: 'High-value spike',
  FAILURE_RATE_SPIKE: 'Failure-rate spike',
  API_LATENCY_SPIKE: 'API latency spike',
  REPEATED_FAILURE: 'Repeated failures',
  MERCHANT_VOLUME_SPIKE: 'Unusual merchant volume',
  INSTITUTION_ACTIVITY: 'Unusual institution activity',
  SETTLEMENT_DELAY: 'Settlement delay',
  TRANSACTION_VOLUME_SPIKE: 'Transaction volume spike',
  UNUSUAL_TIME_ACTIVITY: 'Unusual time activity',
}

export const ANOMALY_STATUSES = ['DETECTED', 'REVIEW', 'CONFIRMED', 'DISMISSED', 'RESOLVED'] as const

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
  'INCIDENT_REPORT',
  'INSTITUTION_PERFORMANCE',
  'TRANSACTION_SUMMARY',
  'ANOMALY_REPORT',
  'RECONCILIATION_REPORT',
  'SYSTEM_HEALTH',
] as const
export type ReportType = (typeof REPORT_TYPES)[number]

export const REPORT_LABEL: Record<ReportType, string> = {
  DAILY_OPERATIONS: 'Daily Operations Report',
  INCIDENT_REPORT: 'Incident Report',
  INSTITUTION_PERFORMANCE: 'Institution Performance Report',
  TRANSACTION_SUMMARY: 'Transaction Report',
  ANOMALY_REPORT: 'Anomaly Report',
  RECONCILIATION_REPORT: 'Reconciliation Report',
  SYSTEM_HEALTH: 'System Health Report',
}

export const RECON_STATUSES = ['MATCHED', 'MISMATCH', 'INVESTIGATING', 'RESOLVED'] as const
export type ReconStatus = (typeof RECON_STATUSES)[number]

export const JOB_TYPES = [
  'EOD_SETTLEMENT',
  'TRANSACTION_RECONCILIATION',
  'DAILY_REPORT',
  'DATA_VALIDATION',
  'BACKUP_SIMULATION',
  'SETTLEMENT_VALIDATION',
] as const
export type JobType = (typeof JOB_TYPES)[number]

export const JOB_LABEL: Record<JobType, string> = {
  EOD_SETTLEMENT: 'EOD Settlement',
  TRANSACTION_RECONCILIATION: 'Transaction Reconciliation',
  DAILY_REPORT: 'Daily Report Generation',
  DATA_VALIDATION: 'Data Validation',
  BACKUP_SIMULATION: 'Backup Simulation',
  SETTLEMENT_VALIDATION: 'Settlement Validation',
}

export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'] as const

export const DQ_STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED'] as const

export const SCENARIOS = [
  'BANK_API_LATENCY',
  'PAYMENT_FAILURE_SPIKE',
  'SETTLEMENT_DELAY',
  'HIGH_VOLUME',
  'MERCHANT_ACTIVITY',
  'NOTIFICATION_DEGRADATION',
] as const
export type Scenario = (typeof SCENARIOS)[number]

export const SCENARIO_LABEL: Record<Scenario, string> = {
  BANK_API_LATENCY: 'Bank API Latency Spike',
  PAYMENT_FAILURE_SPIKE: 'Payment Failure Spike',
  SETTLEMENT_DELAY: 'Settlement Delay',
  HIGH_VOLUME: 'High Transaction Volume',
  MERCHANT_ACTIVITY: 'Merchant Activity Spike',
  NOTIFICATION_DEGRADATION: 'Notification Degradation',
}

export const DEMO_LABELS = {
  environment: 'FinOpsX — Demo Environment',
  synthetic: 'Synthetic Data Only',
  disclaimer: 'Conceptual fintech operations platform. Not affiliated with or endorsed by F1Soft.',
} as const

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

export interface AiAction {
  label: string
  href: string
}
