import process from 'node:process'

// @cloudflare/vitest-pool-workers currently forwards these harmless dependency/runtime logs.
const ignoredTestOutput = [
  '[chat-sdk',
  'disconnected: WebSocket peer disconnected',
  'node_modules/@slack/socket-mode/dist/src/index.js" points to missing source files',
  'node_modules/@slack/web-api/dist/index.js" points to missing source files',
  'node_modules/@workflow/serde/dist/index.js" points to missing source files',
  'console warning; message = Called .text() on an HTTP body which does not appear to be text',
  'rawSpecifier=bufferutil',
  'Using secrets defined in ',
  '__vite-optional-peer-dep:bufferutil:ws',
]

type WriteArgs =
  | []
  | [(error?: Error | null) => void]
  | [NodeJS.BufferEncoding]
  | [NodeJS.BufferEncoding, (error?: Error | null) => void]
type Write = (chunk: string | Uint8Array, ...args: WriteArgs) => boolean

export function filterVitestConsoleLog(log: string) {
  if (log.includes('[chat-sdk')) return false
}

export function setupVitestOutputFilter() {
  const filterTestOutput = (chunk: string | Uint8Array) => {
    const lines = String(chunk).split(/(?<=\n)/)
    let ignoredAnyLine = false
    const text = lines
      .filter((line, index) => {
        if (ignoredTestOutput.some((output) => line.includes(output))) return false
        if (
          line.startsWith('stdout |') &&
          ignoredTestOutput.some((output) => lines[index + 1]?.includes(output))
        )
          return false
        return true
      })
      .join('')
    ignoredAnyLine = text.length !== String(chunk).length
    return { ignoredAnyLine, text }
  }
  let ignoredPreviousStdout = false
  const writeStdout = process.stdout.write.bind(process.stdout) as Write
  process.stdout.write = ((chunk: string | Uint8Array, ...args: WriteArgs) => {
    if (ignoredPreviousStdout && (String(chunk) === '\n' || String(chunk) === '\r\n')) {
      ignoredPreviousStdout = false
      return true
    }
    const filtered = filterTestOutput(chunk)
    ignoredPreviousStdout = filtered.ignoredAnyLine && !filtered.text
    if (!filtered.text) return true
    return writeStdout(filtered.text, ...args)
  }) as typeof process.stdout.write
  let ignoredPreviousStderr = false
  const writeStderr = process.stderr.write.bind(process.stderr) as Write
  process.stderr.write = ((chunk: string | Uint8Array, ...args: WriteArgs) => {
    if (ignoredPreviousStderr && (String(chunk) === '\n' || String(chunk) === '\r\n')) {
      ignoredPreviousStderr = false
      return true
    }
    const filtered = filterTestOutput(chunk)
    ignoredPreviousStderr = filtered.ignoredAnyLine && !filtered.text
    if (!filtered.text) return true
    return writeStderr(filtered.text, ...args)
  }) as typeof process.stderr.write
}
