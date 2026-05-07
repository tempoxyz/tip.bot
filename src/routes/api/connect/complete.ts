import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'

import { encryptSecret, hashValue } from '#/lib/crypto.ts'
import { createDb } from '#/lib/db.ts'
import * as Nanoid from '#/lib/nanoid.ts'

type ConnectEnv = Env & {
  ACCESS_KEY_ENCRYPTION_SECRET?: string
}

export const Route = createFileRoute('/api/connect/complete')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const connectEnv = env as ConnectEnv
        if (!connectEnv.ACCESS_KEY_ENCRYPTION_SECRET)
          return new Response('ACCESS_KEY_ENCRYPTION_SECRET is not configured.', { status: 500 })

        const json = (await request.json()) as CompleteBody
        const token = await createDb(connectEnv.DB)
          .selectFrom('connect_token')
          .selectAll()
          .where('token_hash', '=', await hashValue(json.token))
          .executeTakeFirst()
        if (!token || token.used_at)
          return new Response('Connect token is invalid.', { status: 400 })
        if (new Date(token.expires_at).getTime() <= Date.now())
          return new Response('Connect token expired. Run /tip connect again.', { status: 400 })

        const existing = await createDb(connectEnv.DB)
          .selectFrom('account')
          .select('id')
          .where('workspace_id', '=', token.workspace_id)
          .where('platform', '=', 'slack')
          .where('platform_account_id', '=', token.platform_account_id)
          .executeTakeFirst()
        const accountId = existing?.id ?? Nanoid.generate()
        const encrypted = await encryptSecret(
          json.accessKeyPrivateKey,
          connectEnv.ACCESS_KEY_ENCRYPTION_SECRET,
        )
        const now = new Date().toISOString()

        await createDb(connectEnv.DB)
          .insertInto('account')
          .values({
            access_key_address: json.accessKeyAddress,
            access_key_authorization: JSON.stringify(json.accessKeyAuthorization),
            access_key_ciphertext: encrypted,
            access_key_expires_at: json.accessKeyExpiresAt,
            created_at: now,
            id: accountId,
            platform: 'slack',
            platform_account_id: token.platform_account_id,
            tempo_address: json.tempoAddress.toLowerCase(),
            updated_at: now,
            workspace_id: token.workspace_id,
          })
          .onConflict((oc) =>
            oc.columns(['workspace_id', 'platform', 'platform_account_id']).doUpdateSet({
              access_key_address: json.accessKeyAddress,
              access_key_authorization: JSON.stringify(json.accessKeyAuthorization),
              access_key_ciphertext: encrypted,
              access_key_expires_at: json.accessKeyExpiresAt,
              tempo_address: json.tempoAddress.toLowerCase(),
              updated_at: now,
            }),
          )
          .execute()
        await createDb(connectEnv.DB)
          .updateTable('connect_token')
          .set({ used_at: now })
          .where('id', '=', token.id)
          .execute()

        return Response.json({ ok: true })
      },
    },
  },
})

type CompleteBody = {
  accessKeyAddress: string
  accessKeyAuthorization: unknown
  accessKeyExpiresAt: string
  accessKeyPrivateKey: string
  tempoAddress: string
  token: string
}
