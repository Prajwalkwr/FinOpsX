import type { Server } from 'socket.io'

let io: Server | null = null

export function setIo(server: Server) {
  io = server
}

export function emit(event: string, payload: unknown) {
  io?.emit(event, payload)
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
