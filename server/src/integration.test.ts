import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { app } from './app.js'
import { prisma } from './lib/prisma.js'

/**
 * Integration and security tests against the real Express app and database.
 * They need a migrated, seeded database (CI seeds one); without it every test is skipped rather than failing.
 */
const ACCOUNTS = {
  admin: ['admin@finopsx.demo', 'Admin@12345'],
  ops: ['operations@finopsx.demo', 'Operations@12345'],
  analyst: ['analyst@finopsx.demo', 'Analyst@12345'],
  engineer: ['engineer@finopsx.demo', 'Engineer@12345'],
  auditor: ['auditor@finopsx.demo', 'Auditor@12345'],
} as const
type Account = keyof typeof ACCOUNTS

let ready = false
const tokens = {} as Record<Account, string>
const auth = (who: Account) => ({ Authorization: `Bearer ${tokens[who]}` })

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`
    ready = (await prisma.user.count({ where: { email: ACCOUNTS.admin[0] } })) > 0
  } catch {
    ready = false
  }
  if (!ready) return
  for (const [who, [email, password]] of Object.entries(ACCOUNTS) as Array<[Account, readonly [string, string]]>) {
    const res = await request(app).post('/api/auth/login').send({ email, password })
    tokens[who] = res.body?.data?.accessToken
  }
}, 60_000)

beforeEach((ctx) => {
  if (!ready) ctx.skip()
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('security baseline', () => {
  it('sets secure headers and hides the framework', async () => {
    const res = await request(app).get('/health')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBeDefined()
    expect(res.headers['x-powered-by']).toBeUndefined()
  })

  it('does not leak secrets or connection strings from health checks', async () => {
    const res = await request(app).get('/health')
    const body = JSON.stringify(res.body)
    expect(body).not.toMatch(/postgres(ql)?:\/\//i)
    expect(body).not.toMatch(/secret|password|api[_-]?key/i)
  })

  it('rejects requests without or with a forged token', async () => {
    expect((await request(app).get('/api/dashboard/overview')).status).toBe(401)
    expect((await request(app).get('/api/dashboard/overview').set('Authorization', 'Bearer not.a.jwt')).status).toBe(401)
  })

  it('logs in every demo role and never returns password hashes', async () => {
    for (const who of Object.keys(ACCOUNTS) as Account[]) expect(tokens[who]).toBeTruthy()
    const res = await request(app).get('/api/auth/me').set(auth('admin'))
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/)
  })

  it('uses one message for wrong passwords and unknown users', async () => {
    const wrong = await request(app).post('/api/auth/login').send({ email: ACCOUNTS.admin[0], password: 'Wrong@12345' })
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@finopsx.demo', password: 'Wrong@12345' })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.body.error.message).toBe(unknown.body.error.message)
  })

  it('validates input with a structured 400', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email' })
    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.requestId).toBeTruthy()
  })

  it('rejects malformed JSON and oversized pages', async () => {
    const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad json')
    expect(bad.status).toBe(400)
    expect((await request(app).get('/api/transactions?limit=500').set(auth('ops'))).status).toBe(400)
  })
})

describe('role-based access control', () => {
  const denied: Array<[Account, string, string]> = [
    ['auditor', 'get', '/api/users'],
    ['engineer', 'get', '/api/transactions'],
    ['analyst', 'post', '/api/simulator/start'],
    ['engineer', 'post', '/api/ai/query'],
    ['auditor', 'post', '/api/reconciliation/run'],
    ['analyst', 'patch', '/api/settings/thresholds'],
    ['ops', 'get', '/api/simulator/status'],
  ]
  it.each(denied)('%s cannot %s %s', async (who, method, path) => {
    const res = await (request(app) as unknown as Record<string, (url: string) => request.Test>)[method](path).set(auth(who)).send({})
    expect(res.status).toBe(403)
  })

  it('filters the overview by role', async () => {
    const res = await request(app).get('/api/dashboard/overview?range=24h').set(auth('engineer'))
    expect(res.status).toBe(200)
    expect(res.body.data.recent ?? []).toHaveLength(0)
  })
})

describe('incident lifecycle', () => {
  it('enforces transitions, records audit entries and returns 404/422 correctly', async () => {
    const created = await request(app).post('/api/incidents').set(auth('admin')).send({ title: `Integration test ${Date.now()}`, description: 'Created by the automated integration test.', severity: 'LOW' })
    expect(created.status).toBe(201)
    const id = created.body.data.publicId as string
    expect(created.body.data.status).toBe('DETECTED')

    const skip = await request(app).post(`/api/incidents/${id}/status`).set(auth('admin')).send({ status: 'POST_INCIDENT_REVIEW' })
    expect(skip.status).toBe(422)

    const ack = await request(app).post(`/api/incidents/${id}/status`).set(auth('admin')).send({ status: 'ACKNOWLEDGED' })
    expect(ack.status).toBe(200)

    const audit = await request(app).get(`/api/audit-logs?q=${id}`).set(auth('auditor'))
    expect(audit.status).toBe(200)
    const actions = audit.body.data.items.map((row: { action: string }) => row.action)
    expect(actions).toContain('CREATED_INCIDENT')
    expect(actions).toContain('CHANGED_INCIDENT_STATUS')

    const resolved = await request(app).post(`/api/incidents/${id}/resolve`).set(auth('admin')).send({ resolution: 'Closed by the integration test.' })
    expect(resolved.status).toBe(200)
    expect(resolved.body.data.status).toBe('RESOLVED')

    expect((await request(app).get('/api/incidents/INC-999999').set(auth('admin'))).status).toBe(404)
    expect((await request(app).patch(`/api/incidents/${id}`).set(auth('auditor')).send({ team: 'x' })).status).toBe(403)
  })
})

describe('AI and Ask Your Data guardrails', () => {
  it('refuses SQL and never executes it', async () => {
    const res = await request(app).post('/api/ai/query').set(auth('analyst')).send({ question: 'SELECT * FROM "User"; DROP TABLE "Transaction"' })
    expect(res.status).toBe(422)
    expect(await prisma.transaction.count()).toBeGreaterThan(0)
  })

  it('rejects structured queries outside the whitelist', async () => {
    const res = await request(app).post('/api/ai/query').set(auth('analyst')).send({ query: { entity: 'users', mode: 'list', range: '24h', filters: {} } })
    expect(res.status).toBe(400)
  })

  it('answers a whitelisted query with real rows', async () => {
    const res = await request(app).post('/api/ai/query').set(auth('analyst')).send({ query: { entity: 'transactions', mode: 'aggregate', metric: 'count', groupBy: 'institution', range: '30d', filters: {}, limit: 10 } })
    expect(res.status).toBe(200)
    expect(res.body.data.supported).toBe(true)
    expect(Array.isArray(res.body.data.rows)).toBe(true)
  })

  it('says it lacks data instead of inventing an answer', async () => {
    const res = await request(app).post('/api/ai/chat').set(auth('analyst')).send({ message: 'What is the weather on Mars tomorrow?' })
    expect(res.status).toBe(200)
    expect(res.body.data.message.content).toMatch(/I don't have enough data to answer that/)
  })
})

describe('business rule validation', () => {
  it('rejects simulator rates that leave no successful payments', async () => {
    const res = await request(app).patch('/api/simulator/config').set(auth('admin')).send({ failureRate: 0.7, pendingRate: 0.3 })
    expect(res.status).toBe(422)
  })

  it('rejects unknown fields on strict updates', async () => {
    const res = await request(app).patch('/api/settings/thresholds').set(auth('admin')).send({ latencyMs: 2000, dropTables: true })
    expect(res.status).toBe(400)
  })
})
