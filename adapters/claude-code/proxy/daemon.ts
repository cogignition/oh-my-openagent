// daemon.ts — ensure the omo-proxy server is running.
// Called from hook-bridge on SessionStart.
//
// Env vars:
//   OMO_PROXY_ENABLED=true        — must be set to activate proxy
//   OMO_PROXY_PORT=4315           — proxy listen port
//   OMO_PROXY_TARGET_URL=...      — upstream endpoint
//   OMO_PROXY_API_KEY=sk-...      — upstream API key
//   OMO_PROXY_MODEL=gpt-4o-mini   — optional model override

/// <reference types="bun-types" />

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

function getPort(): number {
  return parseInt(process.env.OMO_PROXY_PORT ?? '4315', 10)
}

function pidFilePath(port: number): string {
  return `/tmp/omo-proxy-${port}.pid`
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPidFile(port: number): number | null {
  const pidFile = pidFilePath(port)
  if (!existsSync(pidFile)) return null
  try {
    const content = readFileSync(pidFile, 'utf8').trim()
    const pid = parseInt(content, 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

function getServerScriptPath(): string {
  return resolve(import.meta.dir, 'server.ts')
}

/**
 * Ensure the omo-proxy daemon is running.
 * No-op if OMO_PROXY_ENABLED is not "true".
 */
function hasProxyConfig(): boolean {
  // Start if any provider entry is configured, or explicit enable flag is set
  if (process.env.OMO_PROXY_ENABLED === 'true') return true
  return Object.keys(process.env).some(k => /^OMO_PROXY_[A-Z0-9]+_TARGET_URL$/.test(k))
}

export async function ensureProxyRunning(): Promise<void> {
  if (!hasProxyConfig()) return

  const port = getPort()
  const existingPid = readPidFile(port)

  if (existingPid !== null && isProcessAlive(existingPid)) {
    // Already running
    return
  }

  // Spawn detached server process
  const serverScript = getServerScriptPath()

  const child = Bun.spawn(['bun', serverScript], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      OMO_PROXY_PORT: String(port),
    },
  })

  // Wait for proxy to accept connections before returning — Claude Code
  // may make API calls immediately after SessionStart completes.
  process.stderr.write(`[omo-proxy] daemon starting (pid ${child.pid}) on port ${port}...\n`)
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100))
    try {
      const res = await fetch(`http://localhost:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(200),
      })
      // Any response (even 400) means the server is up
      if (res.status > 0) {
        process.stderr.write(`[omo-proxy] daemon ready (${(i + 1) * 100}ms)\n`)
        return
      }
    } catch { /* not ready yet */ }
  }
  process.stderr.write(`[omo-proxy] daemon may not be ready after 2s — proceeding anyway\n`)
}
