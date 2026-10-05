#!/usr/bin/env node
// End-to-end smoke test against a running FinOpsX API (local or deployed).
// Usage: node scripts/smoke-api.mjs [baseUrl]   (default http://localhost:4000/api)

const BASE = (process.argv[2] ?? process.env.SMOKE_API_URL ?? 'http://localhost:4000/api').replace(/\/$/, '')
const ACCOUNTS = {
  admin: ['admin@finopsx.demo', 'Admin@12345'],
  ops: ['operations@finopsx.demo', 'Operations@12345'],
  analyst: ['analyst@finopsx.demo', 'Analyst@12345'],
  engineer: ['engineer@finopsx.demo', 'Engineer@12345'],
  auditor: ['auditor@finopsx.demo', 'Auditor@12345'],
}

const results = []
const tokens = {}

async function call(method, path, { as, body, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (as) headers.Authorization = `Bearer ${tokens[as]}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })
  const text = await res.text()
  if (raw) return { status: res.status, text, headers: res.headers }
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON */ }
  return { status: res.status, json, data: json?.data, error: json?.error }
}

function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function expectStatus(name, method, path, status, opts) {
  const res = await call(method, path, opts)
  check(name, res.status === status, `got ${res.status}${res.status !== status && res.error ? `: ${res.error.message}` : ''}`)
  return res
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  console.log(`Smoke testing ${BASE}\n`)

  for (const [key, [email, password]] of Object.entries(ACCOUNTS)) {
    const res = await call('POST', '/auth/login', { body: { email, password } })
    tokens[key] = res.data?.accessToken
    check(`login ${key}`, res.status === 200 && tokens[key], `status ${res.status}`)
  }
  await expectStatus('wrong password is 401', 'POST', '/auth/login', 401, { body: { email: 'admin@finopsx.demo', password: 'nope-nope' } })
  await expectStatus('no token is 401', 'GET', '/dashboard/overview', 401)
  await expectStatus('malformed JSON is 400', 'POST', '/auth/login', 400, { body: '{bad json' })

  const overview = await expectStatus('dashboard overview', 'GET', '/dashboard/overview?range=24h', 200, { as: 'admin' })
  const summary = await call('GET', '/dashboard/summary?range=24h', { as: 'admin' })
  check('overview has transaction totals', typeof overview.data?.kpis?.total === 'number', `total ${overview.data?.kpis?.total}`)
  check('overview and summary agree on totals (single source of truth)', summary.status === 200 && Math.abs((summary.data?.kpis?.total ?? -1) - overview.data?.kpis?.total) <= 50, `${summary.data?.kpis?.total} vs ${overview.data?.kpis?.total}`)

  const txList = await expectStatus('transactions list', 'GET', '/transactions?limit=5&range=24h', 200, { as: 'ops' })
  const firstTx = txList.data?.items?.[0]
  check('transactions are paginated', txList.data && typeof txList.data.total === 'number' && Array.isArray(txList.data.items))
  if (firstTx) {
    const detail = await expectStatus('transaction detail', 'GET', `/transactions/${firstTx.transactionId ?? firstTx.id}`, 200, { as: 'ops' })
    check('transaction detail has lifecycle stages', Array.isArray(detail.data?.lifecycle ?? detail.data?.stages), Object.keys(detail.data ?? {}).join(',').slice(0, 200))
  }
  await expectStatus('unknown transaction is 404', 'GET', '/transactions/TXN-DOES-NOT-EXIST', 404, { as: 'ops' })
  await expectStatus('invalid filter is 400', 'GET', '/transactions?minAmount=500&maxAmount=10', 400, { as: 'ops' })
  const failedBank = await expectStatus('filter by institution code', 'GET', '/transactions?status=FAILED&institution=DBB&limit=3', 200, { as: 'ops' })
  check('institution filter applied', (failedBank.data?.items ?? []).every((row) => row.status === 'FAILED'))
  const csv = await call('GET', '/transactions/export?range=1h', { as: 'ops', raw: true })
  check('transactions CSV export', csv.status === 200 && csv.text.includes('transactionId'), `status ${csv.status}`)

  const institutions = await expectStatus('institutions', 'GET', '/institutions', 200, { as: 'ops' })
  const bankB = (institutions.data ?? []).find((row) => row.code === 'DBB')
  check('Demo Bank B exists', Boolean(bankB))
  if (bankB) await expectStatus('institution detail', 'GET', `/institutions/${bankB.id}`, 200, { as: 'ops' })

  await expectStatus('system health (engineer)', 'GET', '/system/health', 200, { as: 'engineer' })
  const infra = await expectStatus('infrastructure', 'GET', '/system/infrastructure?hours=6', 200, { as: 'engineer' })
  check('infrastructure is labeled as demo', JSON.stringify(infra.data ?? {}).includes('Demo Infrastructure Metrics'))
  const map = await expectStatus('service map', 'GET', '/services/map', 200, { as: 'engineer' })
  check('service map title', map.data?.title === 'FinOpsX Demo Service Architecture')
  const apis = await expectStatus('API endpoints', 'GET', '/apis', 200, { as: 'engineer' })
  const payments = (apis.data?.items ?? []).find((row) => row.key === 'POST /payments')
  check('POST /payments has percentiles', payments && typeof payments.p95Ms === 'number' && typeof payments.p99Ms === 'number', payments ? `p50 ${payments.p50Ms} p95 ${payments.p95Ms} p99 ${payments.p99Ms}` : 'missing')
  const demoKeys = new Set((apis.data?.items ?? []).filter((row) => row.demo).map((row) => row.key))
  check('all five demo endpoints are tracked', ['POST /payments', 'GET /payments/:id', 'POST /refund', 'POST /settlement', 'POST /qr/validate'].every((key) => demoKeys.has(key)), [...demoKeys].join(', '))
  if (payments) await expectStatus('API detail', 'GET', `/apis/${payments.id}`, 200, { as: 'engineer' })

  await expectStatus('analyst cannot view system health (403)', 'GET', '/system/health', 403, { as: 'analyst' })
  await expectStatus('engineer cannot view transactions (403)', 'GET', '/transactions', 403, { as: 'engineer' })
  await expectStatus('auditor cannot manage users (403)', 'GET', '/users', 403, { as: 'auditor' })
  await expectStatus('ops cannot control simulator (403)', 'POST', '/simulator/start', 403, { as: 'ops' })
  await expectStatus('analyst cannot run jobs (403)', 'POST', '/jobs/DATA_VALIDATION/run', 403, { as: 'analyst' })

  await expectStatus('analytics', 'GET', '/analytics?range=7d', 200, { as: 'analyst' })
  await expectStatus('anomalies', 'GET', '/anomalies', 200, { as: 'analyst' })

  const created = await expectStatus('create manual incident', 'POST', '/incidents', 201, { as: 'ops', body: { title: 'Smoke test incident', description: 'Created by the smoke test.', severity: 'LOW' } })
  const incidentId = created.data?.publicId ?? created.data?.id
  if (incidentId) {
    await expectStatus('acknowledge incident', 'POST', `/incidents/${incidentId}/status`, 200, { as: 'ops', body: { status: 'ACKNOWLEDGED' } })
    await expectStatus('invalid transition is 422', 'POST', `/incidents/${incidentId}/status`, 422, { as: 'ops', body: { status: 'DETECTED' } })
    await expectStatus('add incident note', 'POST', `/incidents/${incidentId}/notes`, 201, { as: 'ops', body: { message: 'Smoke note' } })
    await expectStatus('change severity', 'POST', `/incidents/${incidentId}/severity`, 200, { as: 'ops', body: { severity: 'MEDIUM' } })
    await expectStatus('resolve without resolution is 422', 'POST', `/incidents/${incidentId}/resolve`, 422, { as: 'ops', body: { resolution: '' } })
    await expectStatus('resolve incident', 'POST', `/incidents/${incidentId}/resolve`, 200, { as: 'ops', body: { resolution: 'Closed by smoke test.' } })
    await expectStatus('reopen incident', 'POST', `/incidents/${incidentId}/reopen`, 200, { as: 'ops', body: { reason: 'Smoke reopen' } })
    const full = await expectStatus('incident detail', 'GET', `/incidents/${incidentId}`, 200, { as: 'ops' })
    check('incident timeline recorded actions', (full.data?.timeline ?? full.data?.events ?? []).length >= 5, `events ${(full.data?.timeline ?? full.data?.events ?? []).length}`)
    await expectStatus('final resolve', 'POST', `/incidents/${incidentId}/resolve`, 200, { as: 'ops', body: { resolution: 'Closed again by smoke test.' } })
  }

  const recon = await expectStatus('run reconciliation', 'POST', '/reconciliation/run', 201, { as: 'ops', body: { range: 'today' } })
  check('reconciliation has a status', ['MATCHED', 'MISMATCH'].includes(recon.data?.status), recon.data?.status)
  await expectStatus('reconciliation list', 'GET', '/reconciliation', 200, { as: 'auditor' })
  if (recon.data?.id) await expectStatus('reconciliation detail', 'GET', `/reconciliation/${recon.data.id}`, 200, { as: 'ops' })
  await expectStatus('settlements', 'GET', '/settlements', 200, { as: 'ops' })

  const job = await expectStatus('trigger data validation job', 'POST', '/jobs/DATA_VALIDATION/run', 202, { as: 'engineer', body: {} })
  await expectStatus('duplicate job is 409', 'POST', '/jobs/DATA_VALIDATION/run', 409, { as: 'engineer', body: {} })
  if (job.data?.id) {
    let status = job.data.status
    for (let i = 0; i < 20 && !['COMPLETED', 'FAILED'].includes(status); i += 1) {
      await sleep(1000)
      status = (await call('GET', `/jobs/${job.data.id}`, { as: 'engineer' })).data?.status
    }
    check('job completes', status === 'COMPLETED', status)
  }
  await expectStatus('jobs list', 'GET', '/jobs', 200, { as: 'auditor' })

  const dq = await expectStatus('data quality overview', 'GET', '/data-quality', 200, { as: 'analyst' })
  const dqIssue = (dq.data?.issues ?? [])[0]
  if (dqIssue) await expectStatus('data quality drill-down', 'GET', `/data-quality/${dqIssue.id}/records`, 200, { as: 'analyst' })

  const chat = await expectStatus('AI chat', 'POST', '/ai/chat', 200, { as: 'ops', body: { message: 'Which institution has the highest failure rate today?' } })
  check('AI answer has content', typeof chat.data?.message?.content === 'string' && chat.data.message.content.length > 10)
  const noData = await call('POST', '/ai/chat', { as: 'ops', body: { message: 'What is the weather on Mars?' } })
  check('AI admits missing data', noData.data?.message?.content?.includes("I don't have enough data to answer that."), noData.data?.message?.content?.slice(0, 80))
  const ask = await expectStatus('Ask Your Data', 'POST', '/ai/query', 200, { as: 'analyst', body: { question: 'failed transactions by institution today' } })
  check('Ask Your Data returns columns', Array.isArray(ask.data?.columns) && ask.data.columns.length > 0)
  await expectStatus('Ask Your Data refuses SQL (422)', 'POST', '/ai/query', 422, { as: 'analyst', body: { question: 'DROP TABLE "User"; --' } })
  await expectStatus('Ask Your Data rejects bad structured query (400)', 'POST', '/ai/query', 400, { as: 'analyst', body: { query: { entity: 'users', mode: 'list', range: '24h', filters: {}, limit: 10 } } })
  if (ask.data?.query) {
    const exported = await call('POST', '/ai/query/export', { as: 'analyst', body: { query: ask.data.query }, raw: true })
    check('Ask Your Data CSV export', exported.status === 200 && exported.text.length > 10, `status ${exported.status}`)
  }
  await expectStatus('engineer cannot use Ask Your Data (403)', 'POST', '/ai/query', 403, { as: 'engineer', body: { question: 'failed transactions today' } })

  const report = await expectStatus('generate reconciliation report', 'POST', '/reports', 201, { as: 'ops', body: { type: 'RECONCILIATION_REPORT', range: 'today' } })
  if (report.data?.id) {
    const pdf = await call('GET', `/reports/${report.data.id}/download?format=pdf`, { as: 'ops', raw: true })
    check('report PDF download', pdf.status === 200 && pdf.text.startsWith('%PDF'), `status ${pdf.status}`)
    const rcsv = await call('GET', `/reports/${report.data.id}/download?format=csv`, { as: 'ops', raw: true })
    check('report CSV download', rcsv.status === 200, `status ${rcsv.status}`)
    await expectStatus('report view', 'GET', `/reports/${report.data.id}`, 200, { as: 'analyst' })
  }
  await expectStatus('invalid report type is 400', 'POST', '/reports', 400, { as: 'ops', body: { type: 'NOPE' } })

  const audit = await expectStatus('audit logs (auditor)', 'GET', '/audit-logs?limit=50', 200, { as: 'auditor' })
  const actions = new Set((audit.data?.items ?? []).map((row) => row.action))
  check('audit captured incident and reconciliation actions', actions.has('RESOLVED_INCIDENT') && actions.has('RAN_RECONCILIATION'), [...actions].slice(0, 10).join(','))
  const sample = (audit.data?.items ?? [])[0]
  check('audit rows include IP and user agent', sample && 'ipAddress' in sample && 'userAgent' in sample)
  await expectStatus('analyst cannot read audit logs (403)', 'GET', '/audit-logs', 403, { as: 'analyst' })

  await expectStatus('notifications', 'GET', '/notifications', 200, { as: 'ops' })
  await expectStatus('simulator status', 'GET', '/simulator/status', 200, { as: 'admin' })
  await expectStatus('invalid simulator rates are 422', 'PATCH', '/simulator/config', 422, { as: 'admin', body: { failureRate: 0.8, pendingRate: 0.3 } })
  await expectStatus('unknown route is 404', 'GET', '/definitely-not-a-route', 404, { as: 'admin' })

  if (process.argv.includes('--scenario')) await scenarioChain()

  const failed = results.filter((row) => !row.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log('Failures:')
    for (const row of failed) console.log(` - ${row.name} ${row.detail}`)
    process.exit(1)
  }
}

/** Demo Bank B latency: telemetry -> anomaly -> incident -> RCA -> resolve ends the scenario. Takes ~2-3 minutes. */
async function scenarioChain() {
  console.log('\nScenario chain: BANK_API_LATENCY')
  const before = await call('GET', '/simulator/status', { as: 'admin' })
  if (before.data?.scenario) await call('POST', '/simulator/scenario/resolve', { as: 'admin' })
  if (!before.data?.running) await call('POST', '/simulator/start', { as: 'admin' })
  await expectStatus('start BANK_API_LATENCY', 'POST', '/simulator/scenario', 200, { as: 'admin', body: { name: 'BANK_API_LATENCY' } })
  await expectStatus('second scenario is rejected (422)', 'POST', '/simulator/scenario', 422, { as: 'admin', body: { name: 'HIGH_VOLUME' } })

  let incident = null
  let anomaly = null
  const started = Date.now()
  while (Date.now() - started < 240_000 && (!incident || !anomaly)) {
    await sleep(10_000)
    const incidents = await call('GET', '/incidents?active=true&limit=20', { as: 'ops' })
    incident ??= (incidents.data?.items ?? []).find((row) => row.scenario === 'BANK_API_LATENCY')
    const anomalies = await call('GET', '/anomalies?status=DETECTED&limit=20', { as: 'analyst' })
    // Detection refreshes an open anomaly for the same type and entity for up to an hour instead of duplicating it.
    anomaly ??= (anomalies.data?.items ?? []).find((row) => /Demo Bank B/i.test(`${row.title} ${row.entityName ?? ''}`) && new Date(row.detectedAt).getTime() >= started - 3600_000)
    console.log(`  ${Math.round((Date.now() - started) / 1000)}s incident=${incident?.publicId ?? incident?.id ?? '-'} anomaly=${anomaly?.publicId ?? '-'}`)
  }
  check('incident raised for Demo Bank B', Boolean(incident), incident?.title)
  check('anomaly detected for Demo Bank B', Boolean(anomaly), anomaly?.title)
  if (anomaly) check('anomaly records normal vs observed', anomaly.normalValue != null && anomaly.observedValue != null, `${anomaly.normalValue} -> ${anomaly.observedValue}`)

  const bankB = (await call('GET', '/institutions', { as: 'ops' })).data?.find((row) => row.code === 'DBB')
  check('Demo Bank B status derived from telemetry is not operational', bankB && bankB.status !== 'OPERATIONAL', bankB?.status)

  if (incident) {
    const id = incident.publicId ?? incident.id
    const detail = await call('GET', `/incidents/${id}`, { as: 'engineer' })
    check('RCA uses "Likely cause" wording', /likely/i.test(JSON.stringify(detail.data?.rca ?? {})), detail.data?.rca?.likelyCause?.slice(0, 100))
    check('RCA has evidence', (detail.data?.rca?.evidence ?? []).length > 0)
    const chat = await call('POST', '/ai/chat', { as: 'engineer', body: { message: `Explain ${id}` } })
    check('assistant explains the incident with links', (chat.data?.actions ?? []).length > 0, chat.data?.message?.content?.slice(0, 100))
    await expectStatus('engineer acknowledges', 'POST', `/incidents/${id}/status`, 200, { as: 'engineer', body: { status: 'ACKNOWLEDGED' } })
    await expectStatus('engineer resolves', 'POST', `/incidents/${id}/resolve`, 200, { as: 'engineer', body: { resolution: 'Bank B latency scenario resolved by smoke test.' } })
    const after = await call('GET', '/simulator/status', { as: 'admin' })
    check('resolving the incident ends the scenario', !after.data?.scenario, after.data?.scenario ?? 'none')
  } else {
    await call('POST', '/simulator/scenario/resolve', { as: 'admin' })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
