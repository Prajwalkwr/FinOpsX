type Level = 'info' | 'warn' | 'error'

const quiet = Boolean(process.env.VITEST)

function write(level: Level, message: string, fields?: Record<string, unknown>) {
  if (quiet && level === 'info') return
  const payload = {
    time: new Date().toISOString(),
    level,
    message,
    ...fields,
  }
  const line = JSON.stringify(payload)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logger = {
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
}
