import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export function num(value: { toNumber: () => number } | number | null | undefined): number {
  if (value == null) return 0
  if (typeof value === 'number') return value
  return value.toNumber()
}
