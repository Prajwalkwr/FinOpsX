import type { ThresholdConfig } from '@prisma/client'
import { prisma } from '../lib/prisma.js'

let cache: { at: number; value: ThresholdConfig } | null = null

export async function getThresholds() {
  if (cache && Date.now() - cache.at < 5000) return cache.value
  const value = await prisma.thresholdConfig.upsert({
    where: { id: 'default' },
    update: {},
    create: { id: 'default' },
  })
  cache = { at: Date.now(), value }
  return value
}

export function clearThresholdCache() {
  cache = null
}
