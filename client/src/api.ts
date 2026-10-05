export type ApiError = { code: string; message: string; status: number; details?: Array<{ path?: string; message: string }> }

export function errorMessage(error: unknown) {
  const err = error as Partial<ApiError> | null
  if (!err) return 'Something went wrong.'
  if (err.status === 429) return 'Too many requests. Wait a moment and try again.'
  if (err.status && err.status >= 500) return err.message && err.message !== 'Request failed.' ? err.message : 'FinOpsX services hit an error. Try again shortly.'
  const detail = err.details?.[0]
  return detail && err.code === 'VALIDATION_ERROR' ? `${err.message} ${detail.path ? `${detail.path}: ` : ''}${detail.message}` : err.message ?? 'Something went wrong.'
}

/** A fresh key per user action; retries of the same request object reuse it. */
export function idem(prefix: string) {
  return { 'Idempotency-Key': `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
}

const API_URL = import.meta.env.VITE_API_URL ?? ''
const REFRESH_KEY = 'finopsx.refresh'
const ACCESS_KEY = 'finopsx.access'

let accessToken: string | null = sessionStorage.getItem(ACCESS_KEY)
let refreshPromise: Promise<boolean> | null = null

export function getAccessToken() {
  return accessToken
}

export function setSession(tokens: { accessToken: string; refreshToken: string }, remember: boolean) {
  accessToken = tokens.accessToken
  sessionStorage.setItem(ACCESS_KEY, tokens.accessToken)
  const store = remember ? localStorage : sessionStorage
  store.setItem(REFRESH_KEY, tokens.refreshToken)
  if (remember) sessionStorage.removeItem(REFRESH_KEY)
  else localStorage.removeItem(REFRESH_KEY)
}

export function clearSession() {
  accessToken = null
  sessionStorage.removeItem(ACCESS_KEY)
  sessionStorage.removeItem(REFRESH_KEY)
  localStorage.removeItem(REFRESH_KEY)
}

export function refreshTokenValue() {
  return localStorage.getItem(REFRESH_KEY) ?? sessionStorage.getItem(REFRESH_KEY)
}

async function refreshSession() {
  const refreshToken = refreshTokenValue()
  if (!refreshToken) return false
  const response = await fetch(`${API_URL}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  if (!response.ok) {
    clearSession()
    return false
  }
  const body = await response.json()
  const remember = Boolean(localStorage.getItem(REFRESH_KEY))
  setSession(body.data, remember)
  return true
}

export async function api<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(options.headers)
  headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json')
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, headers })
  } catch {
    throw { code: 'NETWORK', message: 'Unable to connect to FinOpsX services.', status: 0 } satisfies ApiError
  }
  if (response.status === 401 && retry && !path.includes('/api/auth/login') && !path.includes('/api/auth/refresh')) {
    refreshPromise ??= refreshSession().finally(() => { refreshPromise = null })
    const ok = await refreshPromise
    if (ok) return api<T>(path, options, false)
    clearSession()
    if (!window.location.pathname.startsWith('/login')) window.location.assign('/login')
    throw { code: 'SESSION_EXPIRED', message: 'Your session has expired. Please sign in again.', status: 401 } satisfies ApiError
  }
  if (response.status === 204) return undefined as T
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    if (!response.ok) throw { code: 'HTTP', message: 'Request failed.', status: response.status } satisfies ApiError
    return (await response.blob()) as T
  }
  const body = await response.json()
  if (!response.ok || body.success === false) {
    throw {
      code: body.error?.code ?? 'HTTP',
      message: body.error?.message ?? 'Request failed.',
      status: response.status,
      details: body.error?.details,
    } satisfies ApiError
  }
  return body.data as T
}

export function download(path: string, init: { method?: string; body?: unknown } = {}, retry = true): Promise<void> {
  const headers: Record<string, string> = {}
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  return fetch(`${API_URL}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }).then(async (response) => {
    if (response.status === 401 && retry) {
      refreshPromise ??= refreshSession().finally(() => { refreshPromise = null })
      if (await refreshPromise) return download(path, init, false)
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw { code: body?.error?.code ?? 'HTTP', message: body?.error?.message ?? 'Download failed.', status: response.status } satisfies ApiError
    }
    const blob = await response.blob()
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'report'
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    URL.revokeObjectURL(url)
  })
}
