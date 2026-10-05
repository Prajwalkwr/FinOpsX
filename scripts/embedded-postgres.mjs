import EmbeddedPostgres from 'embedded-postgres'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const databaseDir = path.join(root, 'data', 'pg')
fs.mkdirSync(databaseDir, { recursive: true })

// UTF8 and UTC regardless of the host OS locale (Windows otherwise defaults to WIN1252 and the local time zone).
const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'finopsx',
  password: 'finopsx_demo',
  port: 5433,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-c', 'timezone=UTC'],
})

const already = fs.existsSync(path.join(databaseDir, 'PG_VERSION'))
if (!already) {
  await pg.initialise()
}
await pg.start()

const client = pg.getPgClient()
await client.connect()
const existing = await client.query("SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = 'finopsx'")
if (!existing.rows.length) {
  await client.query("CREATE DATABASE finopsx ENCODING 'UTF8' TEMPLATE template0")
} else if (existing.rows[0].encoding !== 'UTF8') {
  console.warn(`The finopsx database uses ${existing.rows[0].encoding}. Delete data/pg and restart this script to recreate it as UTF8.`)
}
await client.end()

console.log('Embedded PostgreSQL is ready at postgresql://finopsx:finopsx_demo@127.0.0.1:5433/finopsx')
console.log('Leave this process running while you migrate, seed, and develop.')

process.on('SIGINT', async () => {
  await pg.stop()
  process.exit(0)
})
