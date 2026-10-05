import { Link } from 'react-router-dom'

export function NotFound() {
  return <main className="mx-auto max-w-lg px-4 py-16 text-center"><h1 className="text-2xl font-semibold">Page not found</h1><p className="mt-2 text-sm text-muted">That route is not part of FinOpsX.</p><Link className="mt-4 inline-block text-blue-700" to="/dashboard">Back to dashboard</Link></main>
}

export function AccessDenied() {
  return <main className="mx-auto max-w-lg px-4 py-16 text-center"><h1 className="text-2xl font-semibold">Access denied</h1><p className="mt-2 text-sm text-muted">Your role cannot open this area.</p><Link className="mt-4 inline-block text-blue-700" to="/dashboard">Back to dashboard</Link></main>
}
