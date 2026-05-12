import assert from 'node:assert'
import { fork } from 'node:child_process'

const scriptPath = new URL('devServer.ts', import.meta.url).pathname

export function startDevServer(env: Record<string, string>) {
  return new Promise<{ baseUrl: string; stop: () => void }>((resolve, reject) => {
    const child = fork(scriptPath, {
      detached: true,
      env: {
        ...process.env,
        ...env,
        PLAYWRIGHT: '1',
      },
      execArgv: ['--experimental-strip-types', '--no-warnings'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })

    let stderr = ''
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    const startupTimeoutMs = 60_000 // 1 minute
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`Dev server startup timeout\n${stderr}`))
    }, startupTimeoutMs)

    child.on('message', (baseUrl: string) => {
      clearTimeout(timeout)
      resolve({
        baseUrl,
        stop: () => {
          try {
            if (child.pid) process.kill(-child.pid, 'SIGTERM')
          } catch {}
        },
      })
    })

    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    child.on('exit', (code) => {
      if (code === null || code === 0) return
      clearTimeout(timeout)
      reject(new Error(`Dev server exited with code ${code}\n${stderr}`))
    })
  })
}

if (process.send && process.argv[1] === scriptPath) {
  const { createServer } = await import('vite')
  const port = Number(process.env.PORT)
  assert(Number.isInteger(port) && port > 0, 'PORT is required.')

  const vite = await createServer({
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
    },
  })
  await vite.listen()

  const baseUrl = `http://127.0.0.1:${port}`
  const healthTimeoutMs = 30_000 // 30 seconds
  const healthPollMs = 250 // 250 milliseconds
  const deadline = Date.now() + healthTimeoutMs
  let consecutive = 0
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl)
      if (response.ok) consecutive += 1
      else consecutive = 0
    } catch {
      consecutive = 0
    }
    if (consecutive >= 3) break
    await new Promise((resolve) => setTimeout(resolve, healthPollMs))
  }
  assert(consecutive >= 3, 'Dev server health check timed out.')

  process.send(baseUrl)
}
