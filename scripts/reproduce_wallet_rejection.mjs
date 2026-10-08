import assert from 'node:assert/strict'
import { Remote } from 'accounts'

// Exercise the published SDK's actual remote request handler. Only the
// messenger and wallet account store are test doubles; no wallet is signed.
const address = '0x1111111111111111111111111111111111111111'
const results = []
for (const accounts of [[], [{ address }]]) {
  const listeners = new Map()
  const messages = []
  let approvalsOpened = 0
  let state = { accounts, activeAccount: 0, chainId: 4217 }
  const remote = Remote.create({
    messenger: {
      on(name, handler) {
        listeners.set(name, handler)
        return () => listeners.delete(name)
      },
      send(name, payload) {
        messages.push({ name, payload })
      },
    },
    provider: {
      store: {
        getState: () => state,
        setState: (value) => {
          state = { ...state, ...value }
        },
        persist: { rehydrate: async () => {} },
      },
    },
  })
  remote.onUserRequest(() => {
    approvalsOpened++
  })
  await listeners.get('rpc-requests')(
    {
      account: { address },
      chainId: 4217,
      requests: [
        {
          request: {
            id: 1,
            jsonrpc: '2.0',
            method: 'eth_signTransaction',
            params: [{ from: address, chainId: '0x1079' }],
          },
          status: 'pending',
        },
      ],
    },
    { origin: 'https://tip.bot' },
  )
  const response = messages.find((message) => message.name === 'rpc-response')
  if (accounts.length === 0) {
    assert.equal(approvalsOpened, 0)
    assert.equal(response.payload.error.code, 4001)
    assert.match(response.payload.error.message, /user rejected/i)
    assert.deepEqual(messages[0], { name: 'sync', payload: { valid: false } })
  } else {
    assert.equal(approvalsOpened, 1)
    assert.equal(response, undefined)
  }
  results.push({
    walletHasAccount: accounts.length > 0,
    approvalsOpened,
    error: response?.payload.error ?? null,
  })
}
console.log(JSON.stringify(results, null, 2))
