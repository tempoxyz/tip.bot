import { createServer } from 'node:net'

export async function getAvailablePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 10_000 + Math.floor(Math.random() * 20_000)
    if (await canListen(port)) return port
  }
  throw new Error('Could not allocate a port.')
}

async function canListen(port: number) {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, resolve)
    })
    return true
  } catch {
    return false
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
