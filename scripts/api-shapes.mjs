#!/usr/bin/env node
// Prints the JSON shape of key API responses (developer aid for keeping client types in sync).
// Usage: node scripts/api-shapes.mjs [baseUrl] [pathFilter]
const BASE = (process.argv[2] ?? 'http://localhost:4000/api').replace(/\/$/, '')
const FILTER = process.argv[3] ?? ''

function shape(value, depth = 0) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return value.length ? `[${shape(value[0], depth + 1)}] (${value.length})` : '[]'
  if (typeof value === 'object') {
    if (depth > 3) return '{…}'
    return `{ ${Object.entries(value).map(([key, item]) => `${key}: ${shape(item, depth + 1)}`).join('; ')} }`
  }
  return typeof value
}

const login = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@finopsx.demo', password: 'Admin@12345' }) }).then((res) => res.json())
const headers = { Authorization: `Bearer ${login.data.accessToken}` }
const get = (path) => fetch(`${BASE}${path}`, { headers }).then((res) => res.json()).then((body) => body.data ?? body)

const paths = ['/auth/me', '/dashboard/overview?range=24h', '/realtime/snapshot', '/transactions?limit=1', '/institutions', '/system/health', '/system/infrastructure', '/services/map', '/apis', '/incidents?limit=1', '/anomalies?limit=1', '/analytics?range=7d', '/reports?limit=1', '/reports/schedules', '/reconciliation?limit=1', '/settlements?limit=1', '/jobs?limit=1', '/data-quality', '/audit-logs?limit=1', '/notifications?limit=1', '/simulator/status', '/settings', '/users?limit=1']
const ids = {}
for (const path of paths.filter((item) => item.includes(FILTER))) {
  const data = await get(path)
  console.log(`\n${path}\n  ${shape(data)}`)
  if (path.startsWith('/transactions')) ids.tx = data.items?.[0]?.transactionId
  if (path.startsWith('/incidents')) ids.inc = data.items?.[0]?.publicId
  if (path.startsWith('/apis')) ids.api = data.items?.[0]?.id
  if (path.startsWith('/reconciliation')) ids.rec = data.items?.[0]?.id
  if (path.startsWith('/jobs')) ids.job = data.items?.[0]?.id
  if (path.startsWith('/institutions')) ids.inst = data[0]?.id
  if (path.startsWith('/reports?')) ids.rep = data.items?.[0]?.id
  if (path.startsWith('/anomalies')) ids.anm = data.items?.[0]?.publicId
  if (path.startsWith('/data-quality')) ids.dq = data.issues?.[0]?.id
}
const details = [
  ids.tx && `/transactions/${ids.tx}`,
  ids.inc && `/incidents/${ids.inc}`,
  ids.api && `/apis/${ids.api}`,
  ids.rec && `/reconciliation/${ids.rec}?limit=1`,
  ids.job && `/jobs/${ids.job}`,
  ids.inst && `/institutions/${ids.inst}`,
  ids.rep && `/reports/${ids.rep}`,
  ids.anm && `/anomalies/${ids.anm}`,
  ids.dq && `/data-quality/${ids.dq}/records?limit=1`,
].filter(Boolean)
for (const path of details.filter((item) => item.includes(FILTER))) console.log(`\n${path}\n  ${shape(await get(path))}`)
