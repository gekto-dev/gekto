import { PostHog } from 'posthog-node'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// Public project API key — phc_ keys are safe to ship in client code.
const DEFAULT_API_KEY = 'phc_s8GT8r8YG23NJqUhpyq2XcNegWyLomZjnsJmmtxOKMf'
const DEFAULT_HOST = 'https://us.i.posthog.com'

// Lazy singleton — created on first use
let _client: PostHog | null = null

// Distinct ID used for all events — set once per process
let _distinctId: string = 'anonymous'

export function getPostHog(): PostHog {
  if (!_client) {
    _client = new PostHog(process.env.POSTHOG_API_KEY || DEFAULT_API_KEY, {
      host: process.env.POSTHOG_HOST || DEFAULT_HOST,
      enableExceptionAutocapture: true,
    })
  }
  return _client
}

/** Return the current distinct ID for event capture. */
export function getDistinctId(): string {
  return _distinctId
}

/**
 * Set the distinct ID from the user's stored email or a persisted install UUID.
 * Should be called once during startup / after onboarding completes.
 */
export function initDistinctId(email?: string): void {
  if (email && email.trim()) {
    _distinctId = email.trim()
    return
  }

  // Fall back to a persisted install UUID stored alongside gekto-store.json
  const installIdPath = join(process.cwd(), '.gekto-install-id')
  if (existsSync(installIdPath)) {
    try {
      const id = readFileSync(installIdPath, 'utf8').trim()
      if (id) {
        _distinctId = id
        return
      }
    } catch { /* ignore */ }
  }

  // First run — generate and persist an install UUID
  const id = randomUUID()
  try {
    writeFileSync(installIdPath, id, 'utf8')
  } catch { /* ignore */ }
  _distinctId = id
}
