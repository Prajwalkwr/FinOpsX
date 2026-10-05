import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { can, DEMO_LABELS, formatNpr } from '@finopsx/shared'
import { StatusBadge, statusTone } from '../components/ui'
import { NAV } from '../components/shell'
import { fmtMs, fmtPct, humanize, queryString } from '../lib/format'

describe('shared formatting and access', () => {
  it('formats NPR the way the console displays money', () => {
    expect(formatNpr(4500)).toBe('Rs. 4,500')
    expect(formatNpr(1_250_000)).toBe('Rs. 1.25M')
    expect(formatNpr(18_400_000_000)).toBe('Rs. 18.4B')
  })

  it('keeps auditors out of user management', () => {
    expect(can('AUDITOR', 'users:manage')).toBe(false)
    expect(can('SUPER_ADMIN', 'users:manage')).toBe(true)
  })

  it('matches the RBAC matrix for sensitive capabilities', () => {
    expect(can('ENGINEER', 'transactions:view')).toBe(false)
    expect(can('ENGINEER', 'simulator:control')).toBe(true)
    expect(can('OPERATIONS_MANAGER', 'simulator:control')).toBe(false)
    expect(can('ENGINEER', 'askdata:use')).toBe(false)
    expect(can('ANALYST', 'askdata:use')).toBe(true)
    expect(can('AUDITOR', 'audit:view')).toBe(true)
  })

  it('carries the required demo disclaimers', () => {
    expect(DEMO_LABELS.environment).toBe('FinOpsX — Demo Environment')
    expect(DEMO_LABELS.synthetic).toBe('Synthetic Data Only')
    expect(DEMO_LABELS.disclaimer).toContain('Not affiliated with or endorsed by F1Soft')
  })
})

describe('client formatters', () => {
  it('formats durations and percentages without inventing values', () => {
    expect(fmtMs(420)).toBe('420ms')
    expect(fmtMs(3400)).toBe('3.4s')
    expect(fmtMs(null)).toBe('—')
    expect(fmtPct(12.345)).toBe('12.3%')
    expect(fmtPct(undefined)).toBe('—')
    expect(humanize('POST_INCIDENT_REVIEW')).toBe('Post incident review')
  })

  it('builds query strings without empty or ALL filters', () => {
    expect(queryString({ status: 'FAILED', institution: '', method: 'ALL', page: 2, q: undefined })).toBe('status=FAILED&page=2')
  })
})

describe('status badge', () => {
  it('shows the status text and not color alone', () => {
    render(<StatusBadge status="FAILED" />)
    expect(screen.getByText('FAILED')).toBeInTheDocument()
  })

  it('maps lifecycle states to tones', () => {
    expect(statusTone('RESOLVED')).toBe('good')
    expect(statusTone('DEGRADED')).toBe('warn')
    expect(statusTone('MISMATCH')).toBe('bad')
  })
})

describe('navigation', () => {
  it('lists every required module once', () => {
    const labels = NAV.map((item) => item.label)
    for (const label of ['Overview', 'Transactions', 'System Health', 'Incidents', 'Institutions', 'Anomalies', 'Analytics', 'AI Assistant', 'Reports', 'Notifications', 'Audit Logs', 'Users', 'Operational Jobs', 'Data Quality', 'Service Map', 'Demo Simulator', 'Settings']) {
      expect(labels.filter((item) => item === label)).toHaveLength(1)
    }
  })

  it('shows engineers the simulator but not transactions', () => {
    const visible = NAV.filter((item) => !item.permission || can('ENGINEER', item.permission)).map((item) => item.label)
    expect(visible).toContain('Demo Simulator')
    expect(visible).not.toContain('Transactions')
  })
})
