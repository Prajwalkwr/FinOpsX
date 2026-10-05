import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Spark } from '../components/ui'
import { useAuth } from '../contexts'

const WORDS = ['Monitor.', 'Investigate.', 'Understand.']
const FLOW = ['Bank', 'Payment Switch', 'Wallet', 'Merchant', 'Transaction', 'API', 'Database', 'Notification', 'Settlement']

function ScatterWord({ text, scatter }: { text: string; scatter: number }) {
  return (
    <h1 className="font-display text-[clamp(4.2rem,16vw,11rem)] uppercase leading-[0.85] tracking-tight text-white" style={{ textShadow: '0 10px 40px rgba(30,50,120,.25)' }}>
      {text.split('').map((char, index) => {
        const direction = index % 2 === 0 ? -1 : 1
        const x = scatter * (index - text.length / 2) * 14
        const y = scatter * (70 + (index % 5) * 26) * direction
        return (
          <span
            key={`${char}-${index}`}
            className="inline-block"
            style={{
              transform: `translate(${x}px, ${y}px) rotate(${scatter * direction * (8 + index)}deg)`,
              opacity: 1 - scatter * 0.9,
              filter: `blur(${scatter * 8}px)`,
            }}
          >
            {char === ' ' ? '\u00A0' : char}
          </span>
        )
      })}
    </h1>
  )
}

export function LandingPage() {
  const { user } = useAuth()
  const [progress, setProgress] = useState(0)
  const [open, setOpen] = useState(false)
  const [reduce, setReduce] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => setReduce(media.matches)
    apply()
    media.addEventListener('change', apply)
    const onScroll = () => {
      const node = document.getElementById('sky-pin')
      if (!node) return
      const total = node.offsetHeight - window.innerHeight
      const scrolled = Math.min(Math.max(-node.getBoundingClientRect().top, 0), total)
      setProgress(total > 0 ? scrolled / total : 0)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      media.removeEventListener('change', apply)
      window.removeEventListener('scroll', onScroll)
    }
  }, [])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  const scene = Math.min(WORDS.length - 1, Math.floor(progress * WORDS.length))
  const local = progress * WORDS.length - scene
  const scatter = reduce || scene === WORDS.length - 1 ? 0 : Math.max(0, (local - 0.62) / 0.38)
  const word = WORDS[scene]
  const marquee = useMemo(() => [...FLOW, ...FLOW], [])

  return (
    <div className="bg-[#eef2ff] text-navy-950">
      <header className="fixed inset-x-0 top-0 z-40 flex items-center justify-between px-4 py-4 md:px-8">
        <Link to="/" className="text-sm font-semibold tracking-wide text-white md:text-base">FinOpsX</Link>
        <nav className="hidden items-center gap-6 text-sm text-white/80 md:flex">
          <a href="#platform">Platform</a>
          <a href="#flow">Flow</a>
          <Link to="/login" className="rounded-full border border-white/80 bg-white/80 px-4 py-1.5 text-navy-950">Sign in</Link>
        </nav>
        <button className="relative h-9 w-9 md:hidden" aria-label={open ? 'Close menu' : 'Open menu'} onClick={() => setOpen((value) => !value)}>
          <span className={`absolute left-2 top-3 h-0.5 w-5 bg-white transition ${open ? 'translate-y-[6px] rotate-45' : ''}`} />
          <span className={`absolute left-2 top-[17px] h-0.5 w-5 bg-white transition ${open ? 'scale-0' : ''}`} />
          <span className={`absolute left-2 top-[24px] h-0.5 w-5 bg-white transition ${open ? '-translate-y-[6px] -rotate-45' : ''}`} />
        </button>
      </header>
      {open ? (
        <div className="fixed inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-[#020319]/95 text-3xl text-white backdrop-blur-xl">
          <a href="#platform" onClick={() => setOpen(false)}>Platform</a>
          <a href="#flow" onClick={() => setOpen(false)}>Flow</a>
          <Link to="/login" onClick={() => setOpen(false)}>Sign in</Link>
        </div>
      ) : null}

      <section id="sky-pin" className="relative h-[320vh]">
        <div className="sticky top-0 h-screen overflow-hidden">
          <div className="sky absolute inset-0" />
          <Spark />
          <div className="relative z-10 flex h-full flex-col items-center justify-center px-4 text-center">
            <p className="mb-4 text-xs font-medium uppercase tracking-[0.28em] text-white/80">Financial operations intelligence</p>
            <ScatterWord text={word} scatter={scatter} />
            <p className="mt-6 max-w-xl text-sm text-white/85 md:text-base">A conceptual command center for synthetic payment, bank, wallet, and settlement operations.</p>
            <div className="mt-8 flex gap-3">
              <Link to={user ? '/dashboard' : '/login'} className="rounded-full bg-white px-5 py-2 text-sm font-medium text-navy-950">{user ? 'Open console' : 'Sign in'}</Link>
              <a href="#platform" className="rounded-full border border-white/70 px-5 py-2 text-sm text-white">See the platform</a>
            </div>
            <p className="absolute bottom-8 text-xs uppercase tracking-[0.2em] text-white/70">Scroll</p>
          </div>
        </div>
      </section>

      <section id="platform" className="mx-auto grid max-w-6xl gap-8 px-4 py-20 md:grid-cols-2">
        <div>
          <p className="text-sm uppercase tracking-[0.2em] text-[#445]">About</p>
          <h2 className="mt-3 font-display text-5xl uppercase leading-none md:text-7xl">Taste the signal, not the noise.</h2>
        </div>
        <div className="space-y-4 text-sm leading-6 text-[#243]">
          <p>FinOpsX is an internal operations console: live synthetic transactions, service health, incidents, anomalies, and an assistant that answers from the database.</p>
          <p>This is not an official F1Soft product and it does not connect to private banking systems. Every institution, merchant, and transaction is fictional.</p>
          <p className="font-medium">Monitor. Investigate. Understand.</p>
        </div>
      </section>

      <section id="flow" className="overflow-hidden border-y border-white/40 bg-navy-950 py-4 text-white">
        <div className="marquee-track flex w-max gap-10 px-6 text-sm uppercase tracking-[0.18em]">
          {marquee.map((item, index) => <span key={`${item}-${index}`} className="whitespace-nowrap">{item}</span>)}
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-4 py-16 md:grid-cols-3">
        {[
          ['Transactions', 'Search, filter, and open a full processing timeline.'],
          ['Incidents', 'Rules open incidents, engineers take them, audits record the change.'],
          ['Assistant', 'Ask which institution is failing. The answer comes from the data.'],
        ].map(([title, copy]) => (
          <article key={title} className="rounded-2xl border border-[#d5def8] bg-white/70 p-5">
            <h3 className="font-display text-3xl uppercase">{title}</h3>
            <p className="mt-2 text-sm text-[#345]">{copy}</p>
          </article>
        ))}
      </section>
      <footer className="px-4 py-8 text-center text-xs text-[#456]">
        Conceptual fintech operations platform using synthetic demonstration data.
      </footer>
    </div>
  )
}
