import type { Server } from 'socket.io'
import { PERMISSIONS, type Permission, type Role } from '@finopsx/shared'

let io: Server | null = null

export function setIo(server: Server) {
  io = server
}

export function getIo() {
  return io
}

/** Socket events are delivered only to rooms whose role can read the underlying data. */
const EVENT_PERMISSION: Array<[string, Permission]> = [
  ['transaction:', 'transactions:view'],
  ['incident:', 'incidents:view'],
  ['anomaly:', 'anomalies:view'],
  ['job:', 'jobs:view'],
  ['reconciliation:', 'reconciliation:view'],
  ['settlement:', 'reconciliation:view'],
  ['dataquality:', 'dataquality:view'],
  ['infrastructure:', 'system:view'],
]

export function permissionFor(event: string): Permission {
  return EVENT_PERMISSION.find(([prefix]) => event.startsWith(prefix))?.[1] ?? 'dashboard:view'
}

export function roomsForRole(role: Role) {
  return (Object.keys(PERMISSIONS) as Permission[])
    .filter((permission) => (PERMISSIONS[permission] as readonly Role[]).includes(role))
    .map((permission) => `perm:${permission}`)
}

export function emit(event: string, payload: unknown) {
  io?.to(`perm:${permissionFor(event)}`).emit(event, payload)
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  io?.to(`user:${userId}`).emit(event, payload)
}

export function connectedClients() {
  return io?.engine.clientsCount ?? 0
}

let lastTxEmit = 0
let skippedTx = 0

export function emitTransaction(summary: Record<string, unknown>) {
  const now = Date.now()
  if (now - lastTxEmit < 200) {
    skippedTx += 1
    return
  }
  lastTxEmit = now
  emit('transaction:new', { ...summary, coalesced: skippedTx })
  skippedTx = 0
}
