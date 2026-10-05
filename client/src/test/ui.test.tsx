import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { formatNpr, can } from '@finopsx/shared'
import { StatusBadge } from '../components/ui'

describe('shared formatting and access', () => {
  it('formats NPR the way the console displays money', () => {
    expect(formatNpr(4500)).toBe('Rs. 4,500')
    expect(formatNpr(1_250_000)).toBe('Rs. 1.25M')
    expect(formatNpr(18_400_000_000)).toBe('Rs. 18.4B')
  })

  it('keeps auditors out of user management', () => {
    expect(can('AUDITOR', 'users:manage')).toBe(false)
    expect(can('SUPER_ADMIN', 'users:manage')).toBe(true)
  })
})

describe('status badge', () => {
  it('shows the status text and not color alone', () => {
    render(<StatusBadge status="FAILED" />)
    expect(screen.getByText('FAILED')).toBeInTheDocument()
  })
})
