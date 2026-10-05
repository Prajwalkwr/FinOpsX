export type ApiError = { code: string; message: string; status: number }

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
    } satisfies ApiError
  }
  return body.data as T
}

export function download(path: string) {
  const headers: Record<string, string> = {}
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  return fetch(`${API_URL}${path}`, { headers }).then(async (response) => {
    if (!response.ok) throw { code: 'HTTP', message: 'Download failed.', status: response.status } satisfies ApiError
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
