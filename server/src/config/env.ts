import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'

function findRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'prisma', 'schema.prisma'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

const here = path.dirname(fileURLToPath(import.meta.url))
export const repoRoot = findRoot(here)
dotenv.config({ path: path.join(repoRoot, '.env') })

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().optional().default(''),
  REDIS_URL: z.string().optional().default(''),
  JWT_SECRET: z.string().optional().default(''),
  JWT_REFRESH_SECRET: z.string().optional().default(''),
  AI_PROVIDER: z.preprocess(
    (value) => (value === '' || value == null ? 'mock' : value),
    z.enum(['mock', 'openai']),
  ),
  AI_API_KEY: z.string().optional().default(''),
  AI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  AI_MODEL: z.string().default('gpt-4o-mini'),
  CLIENT_URL: z.string().default('http://localhost:5173'),
  SHOW_DEMO_ACCOUNTS: z.string().optional().default(''),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_FROM: z.string().default('noreply@finopsx.demo'),
  SEED_TRANSACTION_COUNT: z.coerce.number().default(20000),
})

const parsed = schema.parse(process.env)
export const configProblems: string[] = []

if (!parsed.DATABASE_URL) {
  if (parsed.NODE_ENV === 'production') {
    configProblems.push('DATABASE_URL is missing. Point it at a PostgreSQL database.')
  } else {
    parsed.DATABASE_URL = 'postgresql://finopsx:finopsx_demo@127.0.0.1:5433/finopsx'
    process.env.DATABASE_URL = parsed.DATABASE_URL
    console.warn(`[finopsx] DATABASE_URL was empty. Using the local embedded default ${parsed.DATABASE_URL}`)
  }
} else {
  process.env.DATABASE_URL = parsed.DATABASE_URL
}

const DEV_ACCESS = 'dev-only-finopsx-access-secret-change-me'
const DEV_REFRESH = 'dev-only-finopsx-refresh-secret-change-me'
let jwtSecret = parsed.JWT_SECRET
let jwtRefresh = parsed.JWT_REFRESH_SECRET

if (!jwtSecret || !jwtRefresh) {
  if (parsed.NODE_ENV === 'production') {
    configProblems.push('JWT_SECRET and JWT_REFRESH_SECRET are required in production.')
  } else {
    jwtSecret = jwtSecret || DEV_ACCESS
    jwtRefresh = jwtRefresh || DEV_REFRESH
    console.warn('[finopsx] JWT secrets are development defaults. Set JWT_SECRET and JWT_REFRESH_SECRET before a shared deployment.')
  }
}

export const env = {
  nodeEnv: parsed.NODE_ENV,
  port: parsed.PORT,
  databaseUrl: parsed.DATABASE_URL,
  redisUrl: parsed.REDIS_URL,
  jwtSecret,
  jwtRefresh,
  aiProvider: parsed.AI_PROVIDER,
  aiApiKey: parsed.AI_API_KEY,
  aiBaseUrl: parsed.AI_BASE_URL,
  aiModel: parsed.AI_MODEL,
  clientOrigins: parsed.CLIENT_URL.split(',').map((item) => item.trim()).filter(Boolean),
  showDemoAccounts: parsed.SHOW_DEMO_ACCOUNTS === 'true' || parsed.NODE_ENV !== 'production',
  smtpHost: parsed.SMTP_HOST,
  smtpPort: parsed.SMTP_PORT,
  smtpUser: parsed.SMTP_USER,
  smtpPass: parsed.SMTP_PASS,
  smtpFrom: parsed.SMTP_FROM,
  seedTransactionCount: parsed.SEED_TRANSACTION_COUNT,
  aiEnabled: parsed.AI_PROVIDER === 'openai' && parsed.AI_API_KEY.length > 0,
  emailEnabled: parsed.SMTP_HOST.length > 0 && parsed.SMTP_USER.length > 0,
  isProd: parsed.NODE_ENV === 'production',
}

export function isAllowedOrigin(origin?: string) {
  if (!origin || !env.isProd) return true
  if (env.clientOrigins.includes(origin)) return true
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' && url.hostname.endsWith('.vercel.app')
  } catch {
    return false
  }
}
