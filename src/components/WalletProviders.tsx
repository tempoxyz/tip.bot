import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { WagmiProvider, cookieStorage, createConfig, createStorage, http } from 'wagmi'
import { tempo, tempoLocalnet, tempoModerato } from 'wagmi/chains'
import { dangerous_secp256k1, tempoWallet } from 'wagmi/tempo'

const queryClient = new QueryClient()

function Root(props: React.PropsWithChildren<{ feePayer?: string | undefined }>) {
  const [config] = React.useState(() =>
    createConfig({
      chains: [tempo, tempoModerato, tempoLocalnet],
      connectors: [
        __PLAYWRIGHT_ACCOUNT_PRIVATE_KEY__
          ? dangerous_secp256k1({
              ...(props.feePayer ? { feePayer: props.feePayer } : {}),
              privateKey: __PLAYWRIGHT_ACCOUNT_PRIVATE_KEY__,
            })
          : tempoWallet(props.feePayer ? { feePayer: props.feePayer } : {}),
      ],
      multiInjectedProviderDiscovery: false,
      ssr: true,
      storage: createStorage({ storage: cookieStorage }),
      transports: {
        [tempo.id]: http(),
        [tempoLocalnet.id]: http(),
        [tempoModerato.id]: http(),
      },
    }),
  )

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{props.children}</QueryClientProvider>
    </WagmiProvider>
  )
}

export const WalletProviders = { Root }
