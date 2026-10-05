import type { ReactElement } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Role } from '@finopsx/shared'

const state = vi.hoisted(() => ({ role: 'SUPER_ADMIN' as Role, responses: new Map<string, unknown>() }))

vi.mock('../contexts', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Test User', email: 'test@finopsx.demo', role: state.role }, loading: false }),
  useToast: () => ({ push: vi.fn() }),
  useTheme: () => ({ theme: 'light', toggle: vi.fn(), setTheme: vi.fn() }),
}))

vi.mock('../api', () => ({
  api: vi.fn(async (path: string) => {
    for (const [prefix, value] of state.responses) if (path.startsWith(prefix)) return value
    throw { code: 'NOT_FOUND', message: `No mock for ${path}`, status: 404 }
  }),
  download: vi.fn(),
  idem: () => ({ 'Idempotency-Key': 'test' }),
  errorMessage: (error: { message?: string }) => error?.message ?? 'Error',
}))

const { IncidentDetailPage } = await import('../pages/Incidents')
const { AnomaliesPage } = await import('../pages/Operations')
const { AssistantPage } = await import('../pages/Assistant')

function renderAt(path: string, routePath: string, element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path={routePath} element={element} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const incident = {
  publicId: 'INC-1001',
  title: 'Demo Bank B API latency above 2.5s',
  description: 'Average response time breached the threshold.',
  severity: 'HIGH',
  status: 'INVESTIGATING',
  incidentType: 'LATENCY',
  team: 'Payments SRE',
  scenario: 'BANK_API_LATENCY',
  affectedTransactionCount: 42,
  detectedAt: '2026-10-05T10:00:00.000Z',
  acknowledgedAt: '2026-10-05T10:02:00.000Z',
  resolvedAt: null,
  reopenCount: 0,
  assignee: null,
  services: [{ id: 's1', key: 'bank-api', name: 'Bank API', status: 'DEGRADED' }],
  institutions: [{ name: 'Demo Bank B' }],
  rootCause: null,
  rootCauseConfirmed: false,
  resolution: null,
  preventiveAction: null,
  aiSummary: null,
  aiLabel: 'AI-generated analysis from synthetic data.',
  rca: {
    likelyCause: 'Demo Bank B API latency increased, causing payment timeouts.',
    confirmed: false,
    confidence: 0.78,
    confidenceLabel: 'High',
    evidence: [{ label: 'Latency', value: '3.4s vs 420ms baseline', source: 'ApiCall', supports: true }],
    affectedServices: ['Bank API'],
    affectedInstitutions: ['Demo Bank B'],
    impactedDependents: [],
    upstreamDependencies: [],
    correlatedAnomalies: [],
    recentChanges: [],
    recommendedActions: ['Check Demo Bank B connectivity.'],
    actions: [{ label: 'Failed transactions at Demo Bank B', href: '/transactions?institution=DBB&status=FAILED' }],
    limitations: 'Correlation is not causation.',
    generatedAt: '2026-10-05T10:05:00.000Z',
  },
  allowedTransitions: ['IDENTIFIED', 'MITIGATING', 'RESOLVED'],
  timeline: [{ id: 't1', kind: 'DETECTED', message: 'Incident detected from telemetry.', actorEmail: null, timestamp: '2026-10-05T10:00:00.000Z' }],
  anomalies: [],
  affectedTransactions: [],
}

beforeEach(() => {
  state.responses = new Map()
})
afterEach(() => vi.clearAllMocks())

describe('incident detail', () => {
  it('labels AI output as a likely cause and offers only allowed transitions', async () => {
    state.role = 'OPERATIONS_MANAGER'
    state.responses.set('/api/incidents/INC-1001', incident)
    state.responses.set('/api/engineers', [])
    renderAt('/incidents/INC-1001', '/incidents/:id', <IncidentDetailPage />)
    expect(await screen.findByText(/Demo Bank B API latency increased/)).toBeInTheDocument()
    expect(screen.getByText(/^Likely cause/)).toBeInTheDocument()
    expect(screen.queryByText(/^Root cause:/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Identified' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Acknowledged' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Failed transactions at Demo Bank B' })).toHaveAttribute('href', '/transactions?institution=DBB&status=FAILED')
  })

  it('hides lifecycle controls from read-only roles', async () => {
    state.role = 'AUDITOR'
    state.responses.set('/api/incidents/INC-1001', incident)
    renderAt('/incidents/INC-1001', '/incidents/:id', <IncidentDetailPage />)
    await screen.findByText(/Demo Bank B API latency increased/)
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add note' })).not.toBeInTheDocument()
  })

  it('says so when there is not enough evidence', async () => {
    state.role = 'OPERATIONS_MANAGER'
    state.responses.set('/api/incidents/INC-1001', { ...incident, rca: { ...incident.rca, likelyCause: null, evidence: [] } })
    state.responses.set('/api/engineers', [])
    renderAt('/incidents/INC-1001', '/incidents/:id', <IncidentDetailPage />)
    expect(await screen.findByText(/Not enough evidence to name a likely cause yet/)).toBeInTheDocument()
  })
})

describe('anomalies', () => {
  it('is framed as operational anomaly detection with normal vs observed values', async () => {
    state.role = 'ANALYST'
    state.responses.set('/api/anomalies', {
      items: [{ id: 'a1', publicId: 'ANM-1', type: 'API_LATENCY_SPIKE', severity: 'HIGH', status: 'DETECTED', score: 0.91, title: 'Latency spike', description: '', method: 'z-score', entityType: 'INSTITUTION', entityName: 'Demo Bank B', normalValue: 420, observedValue: 3400, detectedAt: new Date().toISOString(), reviewedAt: null, resolvedAt: null, decisionNote: null, institution: 'Demo Bank B', merchant: null, incident: null, evidence: { unit: 'ms' } }],
      page: 1,
      totalPages: 1,
      total: 1,
    })
    renderAt('/anomalies', '/anomalies', <AnomaliesPage />)
    expect(screen.getByRole('heading', { name: 'Operational Anomaly Detection' })).toBeInTheDocument()
    expect(await screen.findByText('3.4s')).toBeInTheDocument()
    expect(screen.getByText((_, node) => node?.tagName === 'TD' && node.textContent === '420ms → 3.4s')).toBeInTheDocument()
    expect(screen.queryByText(/fraud detection/i)).not.toBeInTheDocument()
  })
})

describe('assistant', () => {
  it('uses the FinOpsX name and only shows Ask Your Data to permitted roles', async () => {
    state.responses.set('/api/ai/conversations', [])
    state.role = 'ENGINEER'
    const { unmount } = renderAt('/ai-assistant', '/ai-assistant', <AssistantPage />)
    expect(screen.getByRole('heading', { name: 'FinOpsX AI Operations Assistant' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Ask Your Data' })).not.toBeInTheDocument()
    unmount()
    state.role = 'ANALYST'
    renderAt('/ai-assistant', '/ai-assistant', <AssistantPage />)
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Ask Your Data' })).toBeInTheDocument())
    expect(screen.queryByText(/F1 AI/)).not.toBeInTheDocument()
  })
})
