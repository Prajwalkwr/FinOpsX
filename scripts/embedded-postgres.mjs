import EmbeddedPostgres from 'embedded-postgres'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const databaseDir = path.join(root, 'data', 'pg')
fs.mkdirSync(databaseDir, { recursive: true })

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'finopsx',
  password: 'finopsx_demo',
  port: 5433,
  persistent: true,
})

const already = fs.existsSync(path.join(databaseDir, 'PG_VERSION'))
if (!already) {
  await pg.initialise()
}
await pg.start()
try {
  await pg.createDatabase('finopsx')
} catch {
  // Database already exists.
}
console.log('Embedded PostgreSQL is ready at postgresql://finopsx:finopsx_demo@127.0.0.1:5433/finopsx')
console.log('Leave this process running while you migrate, seed, and develop.')

process.on('SIGINT', async () => {
  await pg.stop()
  process.exit(0)
})
