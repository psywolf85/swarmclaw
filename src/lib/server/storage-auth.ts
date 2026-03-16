import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import { DATA_DIR, IS_BUILD_BOOTSTRAP } from './data-dir'

// --- .env loading ---
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env.local')
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const [k, ...v] = line.split('=')
      if (k && v.length) process.env[k.trim()] = v.join('=').trim()
    })
  }
}
if (!IS_BUILD_BOOTSTRAP) {
  loadEnv()
}

// Auto-generate CREDENTIAL_SECRET if missing
if (!IS_BUILD_BOOTSTRAP && !process.env.CREDENTIAL_SECRET) {
  const secret = crypto.randomBytes(32).toString('hex')
  const envPath = path.join(process.cwd(), '.env.local')
  fs.appendFileSync(envPath, `\nCREDENTIAL_SECRET=${secret}\n`)
  process.env.CREDENTIAL_SECRET = secret
  console.log('[credentials] Generated CREDENTIAL_SECRET in .env.local')
}

// Auto-generate ACCESS_KEY if missing (used for simple auth)
const SETUP_FLAG = path.join(DATA_DIR, '.setup_pending')
if (!IS_BUILD_BOOTSTRAP && !process.env.ACCESS_KEY) {
  const key = crypto.randomBytes(16).toString('hex')
  const envPath = path.join(process.cwd(), '.env.local')
  fs.appendFileSync(envPath, `\nACCESS_KEY=${key}\n`)
  process.env.ACCESS_KEY = key
  fs.writeFileSync(SETUP_FLAG, key)
  console.log(`\n${'='.repeat(50)}`)
  console.log(`  ACCESS KEY: ${key}`)
  console.log(`  Use this key to connect from the browser.`)
  console.log(`${'='.repeat(50)}\n`)
}

export function getAccessKey(): string {
  return process.env.ACCESS_KEY || ''
}

export function validateAccessKey(key: string): boolean {
  return key === process.env.ACCESS_KEY
}

export function isFirstTimeSetup(): boolean {
  return fs.existsSync(SETUP_FLAG)
}

export function markSetupComplete(): void {
  if (fs.existsSync(SETUP_FLAG)) fs.unlinkSync(SETUP_FLAG)
}

/** Replace the access key in memory and in .env.local (first-time setup override). */
export function replaceAccessKey(newKey: string): void {
  const envPath = path.join(process.cwd(), '.env.local')
  if (fs.existsSync(envPath)) {
    const contents = fs.readFileSync(envPath, 'utf-8')
    const updated = contents.replace(/^ACCESS_KEY=.*$/m, `ACCESS_KEY=${newKey}`)
    fs.writeFileSync(envPath, updated)
  } else {
    fs.appendFileSync(envPath, `\nACCESS_KEY=${newKey}\n`)
  }
  process.env.ACCESS_KEY = newKey
}
