import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { Button, Field, inputClass, Spark } from '../components/ui'
import { useAuth, useToast } from '../contexts'
import type { PublicUser } from '@finopsx/shared'

const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
  rememberMe: z.boolean().optional(),
})
type FormValues = z.infer<typeof schema>

const WORDS = ['Monitor.', 'Investigate.', 'Understand.']

export function LoginPage() {
  const { user, login } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const [word, setWord] = useState(0)
  const demo = useQuery({ queryKey: ['demo-accounts'], queryFn: () => api<{ accounts: Array<{ role: string; email: string; password: string; name: string }> }>('/api/auth/demo-accounts') })
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '', rememberMe: true } })

  if (user) return <Navigate to="/dashboard" replace />

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const result = await api<{ accessToken: string; refreshToken: string; user: PublicUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify(values) })
      login(result, Boolean(values.rememberMe))
      navigate('/dashboard')
    } catch (error) {
      toast.push(error instanceof Object && 'message' in error ? String((error as { message: string }).message) : 'Sign in failed.', 'err')
    }
  })

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <section className="sky relative hidden overflow-hidden lg:block">
        <Spark />
        <div className="relative z-10 flex h-full flex-col justify-between p-10 text-white">
          <Link to="/" className="font-semibold">FinOpsX</Link>
          <div>
            <p className="text-xs uppercase tracking-[0.25em]">Financial operations intelligence</p>
            <button className="mt-4 text-left font-display text-7xl uppercase leading-none" onClick={() => setWord((value) => (value + 1) % WORDS.length)}>{WORDS[word]}</button>
            <p className="mt-4 max-w-md text-sm text-white/85">Monitor. Investigate. Understand.</p>
          </div>
          <p className="text-xs text-white/75">Conceptual demonstration. Synthetic data only.</p>
        </div>
      </section>
      <section className="flex items-center justify-center bg-canvas px-4 py-12">
        <form className="w-full max-w-md space-y-4" onSubmit={onSubmit} noValidate>
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-muted">FinOpsX</p>
            <h1 className="mt-2 text-2xl font-semibold">Sign in</h1>
          </div>
          <Field label="Email" error={form.formState.errors.email?.message}>
            <input className={inputClass} type="email" autoComplete="username" {...form.register('email')} />
          </Field>
          <Field label="Password" error={form.formState.errors.password?.message}>
            <input className={inputClass} type="password" autoComplete="current-password" {...form.register('password')} />
          </Field>
          <div className="flex items-center justify-between text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" {...form.register('rememberMe')} /> Remember me</label>
            <Link to="/forgot-password" className="text-blue-700">Forgot password</Link>
          </div>
          <Button className="w-full" type="submit" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}</Button>
          {demo.data?.accounts?.length ? (
            <div className="rounded-md border border-line p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Demo accounts · development only</p>
              <div className="mt-2 grid gap-2">
                {demo.data.accounts.map((account) => (
                  <button key={account.email} type="button" className="rounded border border-line px-2 py-1 text-left text-xs hover:bg-slate-50 dark:hover:bg-white/5" onClick={() => { form.setValue('email', account.email); form.setValue('password', account.password) }}>
                    {account.role.replaceAll('_', ' ')} · {account.email}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </form>
      </section>
    </div>
  )
}

export function ForgotPage() {
  const toast = useToast()
  const [token, setToken] = useState('')
  const form = useForm<{ email: string }>({ resolver: zodResolver(z.object({ email: z.string().email() })) })
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-2xl font-semibold">Forgot password</h1>
      <p className="mt-2 text-sm text-muted">Email delivery is disabled in the demo environment. A reset token is returned here in development.</p>
      <form className="mt-6 space-y-4" onSubmit={form.handleSubmit(async (values) => {
        const result = await api<{ message: string; email: string; resetToken?: string }>('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify(values) })
        setToken(result.resetToken ?? '')
        toast.push(result.email)
      })}>
        <Field label="Email" error={form.formState.errors.email?.message}><input className={inputClass} {...form.register('email')} /></Field>
        <Button type="submit" disabled={form.formState.isSubmitting}>Create reset token</Button>
      </form>
      {token ? <p className="mt-4 break-all text-sm">Development token: {token}. <Link className="text-blue-700" to={`/reset-password?token=${token}`}>Reset password</Link></p> : null}
    </main>
  )
}

export function ResetPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const token = new URLSearchParams(window.location.search).get('token') ?? ''
  const form = useForm<{ password: string }>({ resolver: zodResolver(z.object({ password: z.string().min(8).regex(/[a-z]/).regex(/[A-Z]/).regex(/\d/) })) })
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-2xl font-semibold">Reset password</h1>
      <form className="mt-6 space-y-4" onSubmit={form.handleSubmit(async (values) => {
        try {
          await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password: values.password }) })
          toast.push('Password updated.')
          navigate('/login')
        } catch (error) {
          toast.push((error as { message: string }).message, 'err')
        }
      })}>
        <Field label="New password" error={form.formState.errors.password?.message}><input className={inputClass} type="password" {...form.register('password')} /></Field>
        <Button type="submit" disabled={form.formState.isSubmitting}>Update password</Button>
      </form>
    </main>
  )
}
