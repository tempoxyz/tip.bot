import * as AccessKey from '#/lib/accessKey.ts'
import * as AccountLink from '#/lib/accountLink.ts'
import { formatCurrencyAmount, formatTipAmount } from '#/lib/format.ts'
import * as Nanoid from '#/lib/nanoid.ts'
import * as Tempo from '#/lib/tempo.ts'
import * as Tip from '#/lib/tip.ts'
import * as DB from '#db/client.ts'
import type { DB as Database } from '#db/types.gen.ts'
import { Address, Hex } from 'ox'
import { z } from 'zod'

export const twitterProviderId = 'x'
const twitterDefaultTokenAddress = Address.checksum(Tempo.addressLookup.usdcE)
const twitterStorageProvider = 'slack'
const unboundWalletAddress = Address.checksum('0x0000000000000000000000000000000000000000')

export async function createLinkChallenge(
  env: Env,
  input: { address?: string | undefined; username: string },
) {
  const db = DB.create(env.DB)
  const now = new Date()
  const accessKey = AccessKey.generate()
  const id = Nanoid.generate()
  const walletAddress = input.address ? Address.checksum(input.address) : unboundWalletAddress
  const twitterAccount = await getUserByUsername(env, input.username)
  if (!twitterAccount) throw new Error('Could not find that X account.')
  const workspace = await ensureTwitterWorkspace(db, now.toISOString())
  const tokenAddress = getTwitterDefaultTokenAddress(workspace)
  await db
    .insertInto('provider_link_challenge')
    .values({
      access_key_address: accessKey.address,
      access_key_authorization: null,
      access_key_ciphertext: await AccessKey.encrypt(env, accessKey.privateKey),
      access_key_expires_at: new Date(
        now.getTime() + AccountLink.reusableAccessKeyTtlMs,
      ).toISOString(),
      access_key_public_key: accessKey.publicKey,
      account_id: null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(), // 10 minutes
      id,
      expected_provider_handle: `@${twitterAccount.username}`,
      expected_provider_user_id: twitterAccount.id,
      proof_hash: null,
      provider: 'twitter',
      provider_handle: null,
      provider_user_id: null,
      tweet_id: null,
      updated_at: now.toISOString(),
      used_at: null,
      wallet_address: walletAddress,
    })
    .execute()
  return {
    accessKeyAddress: accessKey.address,
    accessKeyExpiry: new Date(now.getTime() + AccountLink.reusableAccessKeyTtlMs).toISOString(),
    accessKeyLimit: AccountLink.reusableAccessKeyLimitText,
    accessKeyLimitPeriodSeconds: AccountLink.reusableAccessKeyPeriodSeconds,
    accessKeyPublicKey: accessKey.publicKey as `0x${string}`,
    avatarUrl: twitterAccount.profile_image_url,
    chainId: workspace.chain_id,
    challengeId: id,
    name: twitterAccount.name,
    username: twitterAccount.username,
    tokenAddress,
  }
}

export async function createOAuthLinkChallenge(env: Env, input: { address?: string | undefined }) {
  const db = DB.create(env.DB)
  const now = new Date()
  const accessKey = AccessKey.generate()
  const id = Nanoid.generate()
  const walletAddress = input.address ? Address.checksum(input.address) : unboundWalletAddress
  const workspace = await ensureTwitterWorkspace(db, now.toISOString())
  const tokenAddress = getTwitterDefaultTokenAddress(workspace)
  await db
    .insertInto('provider_link_challenge')
    .values({
      access_key_address: accessKey.address,
      access_key_authorization: null,
      access_key_ciphertext: await AccessKey.encrypt(env, accessKey.privateKey),
      access_key_expires_at: new Date(
        now.getTime() + AccountLink.reusableAccessKeyTtlMs,
      ).toISOString(),
      access_key_public_key: accessKey.publicKey,
      account_id: null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(), // 10 minutes
      expected_provider_handle: null,
      expected_provider_user_id: null,
      id,
      proof_hash: null,
      provider: 'twitter',
      provider_handle: null,
      provider_user_id: null,
      tweet_id: null,
      updated_at: now.toISOString(),
      used_at: null,
      wallet_address: walletAddress,
    })
    .execute()
  return {
    accessKeyAddress: accessKey.address,
    accessKeyExpiry: new Date(now.getTime() + AccountLink.reusableAccessKeyTtlMs).toISOString(),
    accessKeyLimit: AccountLink.reusableAccessKeyLimitText,
    accessKeyLimitPeriodSeconds: AccountLink.reusableAccessKeyPeriodSeconds,
    accessKeyPublicKey: accessKey.publicKey as `0x${string}`,
    chainId: workspace.chain_id,
    challengeId: id,
    tokenAddress,
  }
}

export async function createOAuthAuthorizationUrl(
  env: Env,
  input: {
    address: string
    challengeId: string
    keyAuthorization: unknown
    redirectUri: string
  },
) {
  if (!env.TWITTER_OAUTH_CLIENT_ID || !env.TWITTER_OAUTH_CLIENT_SECRET)
    throw new Error('Twitter OAuth is not configured.')

  const db = DB.create(env.DB)
  const challenge = await db
    .selectFrom('provider_link_challenge')
    .selectAll()
    .where('id', '=', input.challengeId)
    .where('provider', '=', 'twitter')
    .executeTakeFirst()
  if (!challenge || challenge.used_at || challenge.expires_at <= new Date().toISOString())
    throw new Error('This Twitter OAuth connection is invalid or expired.')

  const workspace = await ensureTwitterWorkspace(db, new Date().toISOString())
  const verified = await AccountLink.verifyKeyAuthorization({
    accessKeyAddress: challenge.access_key_address,
    chainId: workspace.chain_id,
    env,
    expiresAt: challenge.access_key_expires_at,
    keyAuthorization: input.keyAuthorization,
    rootAddress: input.address,
    tokenAddress: getTwitterDefaultTokenAddress(workspace),
  })
  if (
    challenge.wallet_address !== unboundWalletAddress &&
    !Address.isEqual(verified.rootAddress, challenge.wallet_address as Address.Address)
  )
    throw new Error('Wallet does not match this Twitter OAuth connection.')

  const state = randomBase64Url(32)
  const codeVerifier = randomBase64Url(32)
  const now = new Date()
  await db
    .updateTable('provider_link_challenge')
    .set({
      access_key_authorization: verified.serialized,
      updated_at: now.toISOString(),
      wallet_address: verified.rootAddress,
    })
    .where('id', '=', challenge.id)
    .execute()
  await db
    .insertInto('provider_link_oauth_state')
    .values({
      challenge_id: challenge.id,
      code_verifier_ciphertext: await encryptText(env, codeVerifier),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(), // 10 minutes
      id: Nanoid.generate(),
      state_hash: await AccountLink.hashToken(env, state),
      updated_at: now.toISOString(),
      used_at: null,
    })
    .execute()

  const url = new URL('/i/oauth2/authorize', 'https://x.com')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', env.TWITTER_OAUTH_CLIENT_ID)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('scope', 'tweet.read users.read')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', await createCodeChallenge(codeVerifier))
  url.searchParams.set('code_challenge_method', 'S256')
  return { authorizationUrl: url.toString() }
}

export async function completeOAuthLinkChallenge(
  env: Env,
  input: { code: string; redirectUri: string; state: string },
) {
  if (!env.TWITTER_OAUTH_CLIENT_ID || !env.TWITTER_OAUTH_CLIENT_SECRET)
    throw new Error('Twitter OAuth is not configured.')

  const db = DB.create(env.DB)
  const now = new Date().toISOString()
  const oauthState = await db
    .selectFrom('provider_link_oauth_state')
    .innerJoin(
      'provider_link_challenge',
      'provider_link_challenge.id',
      'provider_link_oauth_state.challenge_id',
    )
    .selectAll('provider_link_oauth_state')
    .select([
      'provider_link_challenge.access_key_authorization',
      'provider_link_challenge.expires_at as challenge_expires_at',
      'provider_link_challenge.id as challenge_id',
      'provider_link_challenge.used_at as challenge_used_at',
    ])
    .where(
      'provider_link_oauth_state.state_hash',
      '=',
      await AccountLink.hashToken(env, input.state),
    )
    .executeTakeFirst()
  if (!oauthState || oauthState.used_at || oauthState.expires_at <= now)
    throw new Error('Twitter OAuth state is invalid or expired.')
  if (
    oauthState.challenge_used_at ||
    oauthState.challenge_expires_at <= now ||
    !oauthState.access_key_authorization
  )
    throw new Error('Twitter OAuth connection is invalid or expired.')

  await db
    .updateTable('provider_link_oauth_state')
    .set({ updated_at: now, used_at: now })
    .where('id', '=', oauthState.id)
    .where('used_at', 'is', null)
    .execute()

  const codeVerifier = await decryptText(env, oauthState.code_verifier_ciphertext)
  const tokenResponse = await fetch(new URL('/2/oauth2/token', env.TWITTER_API_URL), {
    body: new URLSearchParams({
      code: input.code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
    }),
    headers: {
      authorization: `Basic ${btoa(`${env.TWITTER_OAUTH_CLIENT_ID}:${env.TWITTER_OAUTH_CLIENT_SECRET}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    method: 'POST',
  })
  if (!tokenResponse.ok)
    throw new Error(`Twitter OAuth token exchange failed: ${tokenResponse.status}`)
  const tokenJson = z.parse(
    z.object({ access_token: z.string().min(1), token_type: z.string().optional() }),
    await tokenResponse.json(),
  )
  const meUrl = new URL('/2/users/me', env.TWITTER_API_URL)
  meUrl.searchParams.set('user.fields', 'name,profile_image_url,username')
  const meResponse = await fetch(meUrl, {
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  })
  if (!meResponse.ok) throw new Error(`Twitter OAuth user lookup failed: ${meResponse.status}`)
  const me = z.parse(
    z.object({
      data: z.object({ id: z.string(), name: z.string().optional(), username: z.string() }),
    }),
    await meResponse.json(),
  )
  const challenge = await db
    .selectFrom('provider_link_challenge')
    .selectAll()
    .where('id', '=', oauthState.challenge_id)
    .where('provider', '=', 'twitter')
    .executeTakeFirstOrThrow()
  return await completeLinkChallenge(env, challenge, {
    authorHandle: me.data.username,
    authorId: me.data.id,
    id: `oauth:${oauthState.id}`,
    text: '',
  })
}

export async function createProof(
  env: Env,
  input: {
    address: string
    challengeId: string
    keyAuthorization: unknown
    username?: string | undefined
  },
) {
  const db = DB.create(env.DB)
  const challenge = await db
    .selectFrom('provider_link_challenge')
    .selectAll()
    .where('id', '=', input.challengeId)
    .where('provider', '=', 'twitter')
    .executeTakeFirst()
  if (!challenge || challenge.used_at || challenge.expires_at <= new Date().toISOString())
    throw new Error('This Twitter connection proof is invalid or expired.')
  const twitterAccount = await (async () => {
    if (challenge.expected_provider_user_id && challenge.expected_provider_handle)
      return {
        id: challenge.expected_provider_user_id,
        name: challenge.expected_provider_handle.replace(/^@/, ''),
        profile_image_url: undefined,
        username: challenge.expected_provider_handle.replace(/^@/, ''),
      }
    if (!input.username) return null
    return await getUserByUsername(env, input.username)
  })()
  if (!twitterAccount) throw new Error('This Twitter connection proof is invalid or expired.')
  const expectedProviderHandle = `@${twitterAccount.username}`
  const expectedProviderUserId = twitterAccount.id
  if (!expectedProviderUserId || !expectedProviderHandle)
    throw new Error('This Twitter connection proof is invalid or expired.')
  const workspace = await ensureTwitterWorkspace(db, new Date().toISOString())

  const verified = await AccountLink.verifyKeyAuthorization({
    accessKeyAddress: challenge.access_key_address,
    chainId: workspace.chain_id,
    env,
    expiresAt: challenge.access_key_expires_at,
    keyAuthorization: input.keyAuthorization,
    rootAddress: input.address,
    tokenAddress: getTwitterDefaultTokenAddress(workspace),
  })
  if (
    challenge.wallet_address !== unboundWalletAddress &&
    !Address.isEqual(verified.rootAddress, challenge.wallet_address as Address.Address)
  )
    throw new Error('Wallet does not match this Twitter connection proof.')

  const proof = `tb1_${Nanoid.generate()}${Nanoid.generate()}`
  await db
    .updateTable('provider_link_challenge')
    .set({
      access_key_authorization: verified.serialized,
      expected_provider_handle: expectedProviderHandle,
      expected_provider_user_id: expectedProviderUserId,
      proof_hash: await AccountLink.hashToken(env, proof),
      updated_at: new Date().toISOString(),
      wallet_address: verified.rootAddress,
    })
    .where('id', '=', challenge.id)
    .execute()

  const tweetText = [
    `Verifying my identity for @${env.TWITTER_BOT_HANDLE.replace(/^@+/, '')}`,
    '',
    proof,
    '',
    'https://tip.bot',
  ].join('\n')
  const intentUrl = new URL('/intent/tweet', 'https://twitter.com')
  intentUrl.searchParams.set('text', tweetText)
  return {
    avatarUrl: twitterAccount.profile_image_url,
    intentUrl: intentUrl.toString(),
    name: twitterAccount.name,
    proof,
    tweetText,
    username: twitterAccount.username,
  }
}

export async function verifyLinkChallenge(
  env: Env,
  input: {
    challengeId: string
    proof: string
    tweetUrl?: string | undefined
  },
) {
  const db = DB.create(env.DB)
  const challenge = await db
    .selectFrom('provider_link_challenge')
    .selectAll()
    .where('id', '=', input.challengeId)
    .where('provider', '=', 'twitter')
    .executeTakeFirst()
  if (!challenge || challenge.used_at || challenge.expires_at <= new Date().toISOString())
    return { code: 'invalid_challenge' as const, ok: false as const }
  if (!challenge.access_key_authorization || !challenge.proof_hash)
    return { code: 'proof_not_ready' as const, ok: false as const }
  if (!challenge.expected_provider_user_id)
    return { code: 'invalid_challenge' as const, ok: false as const }
  if ((await AccountLink.hashToken(env, input.proof)) !== challenge.proof_hash)
    return { code: 'invalid_proof' as const, ok: false as const }

  const tweet = input.tweetUrl
    ? await getTweetByUrl(env, input.tweetUrl)
    : await findProofTweet(env, input.proof, challenge.expected_provider_user_id)
  if (!tweet) return { code: 'pending' as const, ok: false as const }
  if (!tweet.text.includes(input.proof))
    return { code: 'invalid_tweet' as const, ok: false as const }
  if (tweet.authorId !== challenge.expected_provider_user_id)
    return { code: 'invalid_author' as const, ok: false as const }
  return await completeLinkChallenge(env, challenge, tweet)
}

export async function handleTweet(env: Env, input: TwitterTweetInput) {
  const botHandle = env.TWITTER_BOT_HANDLE.replace(/^@+/, '').toLowerCase()
  if (input.authorHandle?.toLowerCase() === botHandle) {
    console.log('Twitter webhook ignored bot tweet', { tweetId: input.id })
    return
  }
  if (!new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRegex(botHandle)}\\b`, 'iu').test(input.text)) {
    console.log('Twitter webhook ignored tweet without bot mention', { tweetId: input.id })
    return
  }

  if (await verifyLinkChallengeTweet(env, input)) return

  const parsed = await parseTwitterTip(env, input)
  if (!parsed) {
    console.log('Twitter webhook ignored unparsable tweet', { tweetId: input.id })
    return
  }

  if (parsed.code === 'multiple_recipients') {
    console.log('Twitter webhook rejected multiple recipients', { tweetId: input.id })
    await postReply(
      env,
      input.id,
      'Payment not sent. Multi-recipient tips are not supported on X yet; mention one recipient.',
    )
    return
  }

  const result = await Tip.handleTipRequest(env, {
    amount: parsed.amount,
    idempotencyKey: `twitter:${input.id}`,
    memo: parsed.memo,
    provider: twitterStorageProvider,
    providerChannelId: input.conversationId ?? input.id,
    providerId: twitterProviderId,
    providerThreadId: input.id,
    recipientProviderLabel: parsed.recipientHandle,
    recipientProviderUserId: parsed.recipientUserId,
    senderProviderUserId: input.authorId,
    source: 'mention',
    tokenAddress: parsed.tokenAddress ?? undefined,
    workspaceProviderId: twitterProviderId,
  })

  if (result.ok && result.status === 'queued') {
    console.log('Twitter webhook queued pending tip', {
      pendingTipId: result.pendingTipId,
      tweetId: input.id,
    })
    await postReply(
      env,
      input.id,
      `${formatHandle(input.authorHandle)} queued ${formatHandle(parsed.recipientHandle)} ${formatTwitterAmount(result)}${result.memo ? ` for ${result.memo}` : ''}\nConnect to Tipbot to receive it: https://tip.bot/link/x`,
    )
    await Tip.recordPendingTipMessage(env, {
      pendingTipId: result.pendingTipId,
      providerMessageTs: '',
    })
    return
  }
  if (result.ok && result.status === 'sent') {
    console.log('Twitter webhook sent tip', {
      transactionHash: result.transactionHash,
      tweetId: input.id,
    })
    await postReply(
      env,
      input.id,
      formatTwitterReceiptText({
        amount: formatTwitterAmount(result),
        chainId: result.chainId,
        memo: result.memo,
        recipientHandle: parsed.recipientHandle,
        senderHandle: input.authorHandle,
        transactionHash: result.transactionHash,
      }),
    )
    return
  }
  if (!result.ok && result.code === 'sender_unconnected') {
    console.log('Twitter webhook rejected unconnected sender', { tweetId: input.id })
    await postReply(env, input.id, 'Connect to Tipbot to send payments: https://tip.bot/link/x')
    return
  }
  if (!result.ok && result.code === 'confirmation_required' && result.confirmUrl) {
    console.log('Twitter webhook requested confirmation', { tweetId: input.id })
    await postReply(
      env,
      input.id,
      `Tipbot needs your approval to send this payment. Confirm payment: ${result.confirmUrl}`,
    )
    return
  }
  if (!result.ok && result.code === 'insufficient_funds') {
    console.log('Twitter webhook rejected insufficient funds', { tweetId: input.id })
    await postReply(
      env,
      input.id,
      'Payment not sent. Your wallet has insufficient funds. Add funds and try again: https://wallet.tempo.xyz',
    )
    return
  }
  if (!result.ok && result.code === 'self_tip') {
    console.log('Twitter webhook rejected self tip', { tweetId: input.id })
    await postReply(env, input.id, 'Payment not sent. Cannot send a payment to yourself.')
    return
  }
  if (!result.ok && result.code === 'pending') {
    console.log('Twitter webhook payment still sending', { tweetId: input.id })
    await postReply(env, input.id, 'Payment still sending.')
    return
  }
  console.log('Twitter webhook failed tip', {
    code: result.ok ? result.status : result.code,
    tweetId: input.id,
  })
  await postReply(env, input.id, 'Payment failed.')
}

export async function handleWebhook(env: Env, body: unknown) {
  const tweets = parseWebhookTweets(body)
  console.log('Twitter webhook received', { tweetCount: tweets.length })
  for (const tweet of tweets) await handleTweet(env, tweet)
}

export async function verifyWebhookSignature(
  env: Env,
  input: { body: string; signature: string | undefined },
) {
  if (!env.TWITTER_CONSUMER_SECRET) throw new Error('Twitter is not configured.')
  if (!input.signature) return false
  return (
    input.signature ===
    `sha256=${await hmacBase64('SHA-256', env.TWITTER_CONSUMER_SECRET, input.body)}`
  )
}

export async function handleCrcChallenge(env: Env, crcToken: string) {
  if (!env.TWITTER_CONSUMER_SECRET) throw new Error('Twitter is not configured.')
  return Response.json({
    response_token: `sha256=${await hmacBase64('SHA-256', env.TWITTER_CONSUMER_SECRET, crcToken)}`,
  })
}

export async function updatePendingTipMessage(env: Env, result: Tip.PendingTipClaimResult) {
  if (result.pendingTip.provider_id !== twitterProviderId) return
  const recipient = await getTwitterIdentity(
    DB.create(env.DB),
    result.pendingTip.recipient_provider_user_id,
  )
  const sender = await getTwitterIdentity(
    DB.create(env.DB),
    result.pendingTip.sender_provider_user_id,
  )
  const recipientHandle = recipient?.display_name?.replace(/^@+/, '')
  const senderHandle = sender?.display_name?.replace(/^@+/, '')
  const text = result.ok
    ? formatTwitterReceiptText({
        amount: formatTwitterAmount(result),
        chainId: result.chainId,
        memo: result.memo,
        recipientHandle,
        senderHandle,
        transactionHash: result.transactionHash,
      })
    : result.status === 'expired'
      ? `Expired before ${formatHandle(recipientHandle)} connected. No payment was sent.`
      : 'Payment failed. No payment was sent.'
  await postReply(
    env,
    result.pendingTip.provider_thread_id ?? result.pendingTip.provider_channel_id,
    text,
  )
}

export function formatTwitterReceiptText(input: {
  amount: string
  chainId: number
  memo: string | null | undefined
  recipientHandle: string | undefined
  senderHandle: string | undefined
  transactionHash: string
}) {
  return `${formatHandle(input.senderHandle)} ${input.memo ? 'sent' : 'tipped'} ${formatHandle(input.recipientHandle)} ${input.amount}${input.memo ? ` for ${input.memo}` : ''}\nReceipt: ${Tempo.formatTxLink(input.chainId, input.transactionHash)}`
}

export function parseWebhookTweets(body: unknown): TwitterTweetInput[] {
  const simple = z.safeParse(
    z.object({
      authorHandle: z.string().optional(),
      authorId: z.string(),
      conversationId: z.string().optional(),
      id: z.string(),
      replyToAuthorId: z.string().optional(),
      text: z.string(),
    }),
    body,
  )
  if (simple.success) return [simple.data]

  const v1 = z.safeParse(
    z.object({
      tweet_create_events: z.array(
        z.object({
          display_text_range: z.tuple([z.number(), z.number()]).optional(),
          extended_tweet: z
            .object({
              display_text_range: z.tuple([z.number(), z.number()]).optional(),
              full_text: z.string(),
            })
            .optional(),
          id_str: z.string(),
          in_reply_to_status_id_str: z.string().nullable().optional(),
          in_reply_to_user_id_str: z.string().nullable().optional(),
          text: z.string(),
          user: z.object({ id_str: z.string(), screen_name: z.string().optional() }),
        }),
      ),
    }),
    body,
  )
  if (v1.success)
    return v1.data.tweet_create_events.map((tweet) => ({
      authorHandle: tweet.user.screen_name,
      authorId: tweet.user.id_str,
      conversationId: tweet.in_reply_to_status_id_str ?? tweet.id_str,
      id: tweet.id_str,
      replyToAuthorId: tweet.in_reply_to_user_id_str ?? undefined,
      text: getTwitterDisplayText(
        tweet.extended_tweet?.full_text ?? tweet.text,
        tweet.extended_tweet?.display_text_range ?? tweet.display_text_range,
      ),
    }))

  const v2 = z.safeParse(
    z.object({
      data: z.object({
        author_id: z.string(),
        conversation_id: z.string().optional(),
        id: z.string(),
        referenced_tweets: z.array(z.object({ id: z.string(), type: z.string() })).optional(),
        text: z.string(),
      }),
      includes: z
        .object({
          tweets: z.array(z.object({ author_id: z.string(), id: z.string() })).optional(),
          users: z.array(z.object({ id: z.string(), username: z.string().optional() })).optional(),
        })
        .optional(),
    }),
    body,
  )
  if (!v2.success) return []
  const reply = v2.data.data.referenced_tweets?.find((tweet) => tweet.type === 'replied_to')
  return [
    {
      authorHandle: v2.data.includes?.users?.find((user) => user.id === v2.data.data.author_id)
        ?.username,
      authorId: v2.data.data.author_id,
      conversationId: v2.data.data.conversation_id,
      id: v2.data.data.id,
      replyToAuthorId: v2.data.includes?.tweets?.find((tweet) => tweet.id === reply?.id)?.author_id,
      text: v2.data.data.text,
    },
  ]
}

type TwitterTweetInput = {
  authorHandle?: string | undefined
  authorId: string
  conversationId?: string | undefined
  id: string
  replyToAuthorId?: string | undefined
  text: string
}

async function verifyLinkChallengeTweet(env: Env, tweet: TwitterTweetInput) {
  for (const match of tweet.text.matchAll(
    /(?:^|[^0-9A-Za-z_])(tb1_[0-9a-z]{24})(?=$|[^0-9A-Za-z_])/g,
  )) {
    const proof = match[1]
    if (!proof) continue
    const challenge = await DB.create(env.DB)
      .selectFrom('provider_link_challenge')
      .selectAll()
      .where('provider', '=', 'twitter')
      .where('proof_hash', '=', await AccountLink.hashToken(env, proof))
      .where('expected_provider_user_id', '=', tweet.authorId)
      .where('used_at', 'is', null)
      .executeTakeFirst()
    if (!challenge || !challenge.access_key_authorization) continue
    if (challenge.expires_at <= new Date().toISOString()) continue

    await completeLinkChallenge(env, challenge, tweet)
    console.log('Twitter webhook verified link challenge', {
      challengeId: challenge.id,
      tweetId: tweet.id,
    })
    return true
  }
  return false
}

async function completeLinkChallenge(
  env: Env,
  challenge: Database.Selectable.provider_link_challenge,
  tweet: { authorHandle?: string | undefined; authorId: string; id: string; text: string },
) {
  const db = DB.create(env.DB)
  const now = new Date().toISOString()
  const walletAddress = Address.checksum(challenge.wallet_address)
  const existingAccount = await db
    .selectFrom('account')
    .selectAll()
    .where('address', '=', walletAddress)
    .executeTakeFirst()
  const existingIdentity = await db
    .selectFrom('provider_identity')
    .selectAll()
    .where('provider', '=', twitterStorageProvider)
    .where('provider_workspace_id', '=', twitterProviderId)
    .where('provider_user_id', '=', tweet.authorId)
    .executeTakeFirst()

  const account = existingAccount ?? (await createAccount(db, walletAddress, now))
  const workspace = await ensureTwitterWorkspace(db, now)
  const tokenAddress = getTwitterDefaultTokenAddress(workspace)
  const identity = existingIdentity ?? (await createTwitterIdentity(db, account.id, tweet, now))
  await db
    .updateTable('provider_identity')
    .set({ account_id: null, updated_at: now })
    .where('provider', '=', twitterStorageProvider)
    .where('provider_workspace_id', '=', twitterProviderId)
    .where('account_id', '=', account.id)
    .where('provider_user_id', '!=', tweet.authorId)
    .execute()
  if (!existingIdentity)
    await db
      .updateTable('provider_identity')
      .set({ account_id: account.id, updated_at: now })
      .where('id', '=', identity.id)
      .execute()
  else
    await db
      .updateTable('provider_identity')
      .set({
        account_id: account.id,
        display_name: tweet.authorHandle ? `@${tweet.authorHandle}` : existingIdentity.display_name,
        updated_at: now,
      })
      .where('id', '=', existingIdentity.id)
      .execute()

  const member = await ensureTwitterMember(db, workspace.id, identity.id, tweet, now)
  await db
    .deleteFrom('access_key')
    .where('account_id', '=', account.id)
    .where('chain_id', '=', workspace.chain_id)
    .where('token_address', '=', tokenAddress)
    .execute()
  await db
    .deleteFrom('access_key')
    .where('account_id', '=', account.id)
    .where('chain_id', '=', workspace.chain_id)
    .where('token_address', '=', Address.checksum(Tempo.addressLookup.pathUsd))
    .execute()
  await db
    .deleteFrom('access_key')
    .where('account_id', '=', account.id)
    .where('chain_id', '=', workspace.chain_id)
    .where('token_address', 'is', null)
    .execute()
  await db
    .insertInto('access_key')
    .values({
      account_id: account.id,
      address: challenge.access_key_address,
      authorization: challenge.access_key_authorization!,
      authorization_used_at: null,
      chain_id: workspace.chain_id,
      ciphertext: challenge.access_key_ciphertext,
      created_at: now,
      expires_at: challenge.access_key_expires_at,
      id: Nanoid.generate(),
      revoked_at: null,
      token_address: tokenAddress,
      updated_at: now,
    })
    .execute()
  await db
    .updateTable('provider_link_challenge')
    .set({
      account_id: account.id,
      provider_handle: tweet.authorHandle ? `@${tweet.authorHandle}` : null,
      provider_user_id: tweet.authorId,
      tweet_id: tweet.id,
      updated_at: now,
      used_at: now,
    })
    .where('id', '=', challenge.id)
    .execute()

  const pendingTips = await db
    .selectFrom('pending_tip')
    .select('id')
    .where('recipient_member_id', '=', member.id)
    .where('status', '=', 'pending')
    .execute()
  for (const pendingTip of pendingTips)
    await env.PENDING_TIP_QUEUE.send({ pendingTipId: pendingTip.id })
  return { handle: tweet.authorHandle ? `@${tweet.authorHandle}` : undefined, ok: true as const }
}

async function parseTwitterTip(env: Env, input: TwitterTweetInput) {
  const botHandle = env.TWITTER_BOT_HANDLE.replace(/^@+/, '')
  const handles = [...input.text.matchAll(/(^|[^\p{L}\p{N}_])@([A-Za-z0-9_]{1,15})/gu)]
    .map((match) => match[2]!)
    .filter((handle) => handle.toLowerCase() !== botHandle.toLowerCase())
  const uniqueHandles = [...new Set(handles.map((handle) => handle.toLowerCase()))]
  if (uniqueHandles.length > 1) return { code: 'multiple_recipients' as const }

  const explicitHandle = uniqueHandles[0]
  const recipient = explicitHandle
    ? await getUserByUsername(env, explicitHandle)
    : input.replyToAuthorId
      ? { id: input.replyToAuthorId, username: undefined }
      : null
  if (!recipient) return null

  const remaining = input.text
    .replace(new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRegex(botHandle)}\\b`, 'giu'), '$1')
    .replace(
      explicitHandle
        ? new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRegex(explicitHandle)}\\b`, 'giu')
        : /$a/,
      '$1',
    )
    .trim()
  if (!explicitHandle && !remaining) return null

  const parsed = Tip.parseTipText(
    `<@${recipient.id}${recipient.username ? `|@${recipient.username}` : ''}> ${remaining}`,
  )
  if (!parsed) return null
  let tokenAddress = null
  if (parsed.token) {
    const workspace = await ensureTwitterWorkspace(DB.create(env.DB), new Date().toISOString())
    tokenAddress = Tempo.getTokenAddress(workspace.chain_id, parsed.token)
    if (!tokenAddress) return null
  }
  if (Tip.isTransferMemoTooLong(parsed.memo)) return null
  return {
    amount: parsed.amount,
    memo: parsed.memo,
    recipientHandle: recipient.username ?? explicitHandle,
    recipientUserId: recipient.id,
    tokenAddress,
  }
}

function getTwitterDefaultTokenAddress(workspace: {
  chain_id: number
  default_token_address: string | null
}) {
  const fallback = getTwitterDefaultTokenAddressForChain(workspace.chain_id)
  const tokenAddress = Address.checksum(workspace.default_token_address ?? fallback)
  if (Tempo.isAllowedToken(workspace.chain_id, tokenAddress)) return tokenAddress
  return fallback
}

function getTwitterDefaultTokenAddressForChain(chainId: number) {
  if (chainId === Tempo.chainLookup.mainnet) return twitterDefaultTokenAddress
  return Address.checksum(Tempo.addressLookup.pathUsd)
}

async function getTweetByUrl(env: Env, tweetUrl: string) {
  const tweetId = tweetUrl.match(/(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d+)/)?.[1]
  if (!tweetId) return null
  return await getTweet(env, tweetId)
}

async function findProofTweet(env: Env, proof: string, authorId: string) {
  const url = new URL('/2/tweets/search/recent', env.TWITTER_API_URL)
  url.searchParams.set('query', `"${proof}" @${env.TWITTER_BOT_HANDLE.replace(/^@+/, '')}`)
  url.searchParams.set('tweet.fields', 'author_id,created_at')
  url.searchParams.set('expansions', 'author_id')
  url.searchParams.set('user.fields', 'username')
  const json = z.parse(
    z.object({
      data: z
        .array(z.object({ author_id: z.string(), id: z.string(), text: z.string() }))
        .optional(),
      includes: z
        .object({ users: z.array(z.object({ id: z.string(), username: z.string() })).optional() })
        .optional(),
    }),
    await twitterFetch(env, url).then((response) => response.json()),
  )
  const tweet = json.data?.find((item) => item.text.includes(proof) && item.author_id === authorId)
  if (!tweet) return null
  return {
    authorHandle: json.includes?.users?.find((user) => user.id === tweet.author_id)?.username,
    authorId: tweet.author_id,
    id: tweet.id,
    text: tweet.text,
  }
}

async function getTweet(env: Env, tweetId: string) {
  const url = new URL(`/2/tweets/${tweetId}`, env.TWITTER_API_URL)
  url.searchParams.set('tweet.fields', 'author_id,created_at')
  url.searchParams.set('expansions', 'author_id')
  url.searchParams.set('user.fields', 'username')
  const json = z.parse(
    z.object({
      data: z.object({ author_id: z.string(), id: z.string(), text: z.string() }).optional(),
      includes: z
        .object({ users: z.array(z.object({ id: z.string(), username: z.string() })).optional() })
        .optional(),
    }),
    await twitterFetch(env, url).then((response) => response.json()),
  )
  if (!json.data) return null
  return {
    authorHandle: json.includes?.users?.find((user) => user.id === json.data?.author_id)?.username,
    authorId: json.data.author_id,
    id: json.data.id,
    text: json.data.text,
  }
}

export async function getUserByUsername(env: Env, username: string) {
  const url = new URL(`/2/users/by/username/${username.replace(/^@+/, '')}`, env.TWITTER_API_URL)
  url.searchParams.set('user.fields', 'name,profile_image_url,username')
  const json = z.parse(
    z.object({
      data: z
        .object({
          id: z.string(),
          name: z.string().optional(),
          profile_image_url: z.string().optional(),
          username: z.string(),
        })
        .optional(),
    }),
    await twitterFetch(env, url).then((response) => response.json()),
  )
  return json.data ? { ...json.data, name: json.data.name ?? json.data.username } : null
}

async function postReply(env: Env, replyToTweetId: string, text: string) {
  const url = new URL('/2/tweets', env.TWITTER_API_URL)
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('authorization', await createOAuth1Header(env, 'POST', url))
  const response = await fetch(url, {
    body: JSON.stringify({ reply: { in_reply_to_tweet_id: replyToTweetId }, text }),
    headers,
    method: 'POST',
  })
  if (!response.ok) throw new Error(`Twitter API post failed: ${await response.text()}`)
}

async function twitterFetch(env: Env, url: URL, init: RequestInit = {}) {
  if (!env.TWITTER_BEARER_TOKEN) throw new Error('Twitter is not configured.')
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${env.TWITTER_BEARER_TOKEN}`)
  const response = await fetch(url, {
    ...init,
    headers,
  })
  if (!response.ok) throw new Error(`Twitter API request failed: ${response.status}`)
  return response
}

async function createOAuth1Header(env: Env, method: string, url: URL) {
  if (
    !env.TWITTER_ACCESS_TOKEN ||
    !env.TWITTER_ACCESS_TOKEN_SECRET ||
    !env.TWITTER_CONSUMER_KEY ||
    !env.TWITTER_CONSUMER_SECRET
  )
    throw new Error('Twitter is not configured.')
  const oauthParams = {
    oauth_consumer_key: env.TWITTER_CONSUMER_KEY,
    oauth_nonce: crypto.randomUUID().replaceAll('-', ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: env.TWITTER_ACCESS_TOKEN,
    oauth_version: '1.0',
  }
  const signatureParams = [...Object.entries(oauthParams), ...url.searchParams.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )
  const parameterString = signatureParams
    .map(([key, value]) => `${oauthEncode(key)}=${oauthEncode(value)}`)
    .join('&')
  const signatureBaseString = [
    method.toUpperCase(),
    oauthEncode(`${url.origin}${url.pathname}`),
    oauthEncode(parameterString),
  ].join('&')
  const signature = await hmacBase64(
    'SHA-1',
    `${oauthEncode(env.TWITTER_CONSUMER_SECRET)}&${oauthEncode(env.TWITTER_ACCESS_TOKEN_SECRET)}`,
    signatureBaseString,
  )
  return `OAuth ${Object.entries({ ...oauthParams, oauth_signature: signature })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${oauthEncode(key)}="${oauthEncode(value)}"`)
    .join(', ')}`
}

async function createAccount(db: DB.Type, address: string, now: string) {
  const id = Nanoid.generate()
  await db.insertInto('account').values({ address, created_at: now, id, updated_at: now }).execute()
  return await db.selectFrom('account').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

async function ensureTwitterWorkspace(db: DB.Type, now: string) {
  const existing = await db
    .selectFrom('workspace')
    .selectAll()
    .where('provider', '=', twitterStorageProvider)
    .where('provider_id', '=', twitterProviderId)
    .executeTakeFirst()
  if (existing) return existing
  const id = Nanoid.generate()
  await db
    .insertInto('workspace')
    .values({
      chain_id: Tempo.chainLookup.mainnet,
      created_at: now,
      default_amount: 1000,
      default_token_address: twitterDefaultTokenAddress,
      id,
      installed_at: now,
      name: 'X',
      provider: twitterStorageProvider,
      provider_id: twitterProviderId,
      uninstalled_at: null,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(['provider', 'provider_id']).doNothing())
    .execute()
  return await db.selectFrom('workspace').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

async function createTwitterIdentity(
  db: DB.Type,
  accountId: string,
  tweet: { authorHandle?: string | undefined; authorId: string },
  now: string,
) {
  const id = Nanoid.generate()
  await db
    .insertInto('provider_identity')
    .values({
      account_id: accountId,
      created_at: now,
      display_name: tweet.authorHandle ? `@${tweet.authorHandle}` : null,
      id,
      metadata: null,
      provider: twitterStorageProvider,
      provider_global_user_id: tweet.authorId,
      provider_user_id: tweet.authorId,
      provider_workspace_id: twitterProviderId,
      real_name: null,
      updated_at: now,
    })
    .execute()
  return await db
    .selectFrom('provider_identity')
    .selectAll()
    .where('provider', '=', twitterStorageProvider)
    .where('provider_workspace_id', '=', twitterProviderId)
    .where('provider_user_id', '=', tweet.authorId)
    .executeTakeFirstOrThrow()
}

async function ensureTwitterMember(
  db: DB.Type,
  workspaceId: string,
  identityId: string,
  tweet: { authorHandle?: string | undefined; authorId: string },
  now: string,
) {
  const existing = await db
    .selectFrom('member')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('provider_user_id', '=', tweet.authorId)
    .executeTakeFirst()
  if (existing) return existing
  const id = Nanoid.generate()
  await db
    .insertInto('member')
    .values({
      created_at: now,
      id,
      login: tweet.authorHandle ? `@${tweet.authorHandle}` : null,
      name: null,
      provider_identity_id: identityId,
      provider_user_id: tweet.authorId,
      updated_at: now,
      workspace_id: workspaceId,
    })
    .onConflict((oc) => oc.columns(['workspace_id', 'provider_user_id']).doNothing())
    .execute()
  return await db.selectFrom('member').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

async function getTwitterIdentity(db: DB.Type, providerUserId: string) {
  return await db
    .selectFrom('provider_identity')
    .select(['display_name'])
    .where('provider', '=', twitterStorageProvider)
    .where('provider_workspace_id', '=', twitterProviderId)
    .where('provider_user_id', '=', providerUserId)
    .executeTakeFirst()
}

function formatTwitterAmount(input: {
  amount: string
  isDefaultToken: boolean
  tokenCurrency: string
  tokenSymbol: string
}) {
  return input.isDefaultToken
    ? formatCurrencyAmount(input.amount, input.tokenCurrency)
    : formatTipAmount(input.amount, input.tokenCurrency, input.tokenSymbol)
}

function formatHandle(value: string | undefined) {
  if (!value) return '@account'
  return `@${value.replace(/^@+/, '')}`
}

function getTwitterDisplayText(text: string, range: [number, number] | undefined) {
  if (!range) return text
  return Array.from(text).slice(range[0], range[1]).join('').trim()
}

async function encryptText(env: Pick<Env, 'SECRET_KEY'>, text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { iv, name: 'AES-GCM' },
    await getAesKey(env, ['encrypt']),
    new TextEncoder().encode(text),
  )
  return `${Hex.fromBytes(iv)}.${Hex.fromBytes(new Uint8Array(encrypted))}`
}

async function decryptText(env: Pick<Env, 'SECRET_KEY'>, ciphertext: string) {
  const [iv, encrypted] = ciphertext.split('.')
  if (!iv || !encrypted) throw new Error('Twitter OAuth state is invalid.')
  const decrypted = await crypto.subtle.decrypt(
    { iv: new Uint8Array(Hex.toBytes(iv as Hex.Hex)), name: 'AES-GCM' },
    await getAesKey(env, ['decrypt']),
    new Uint8Array(Hex.toBytes(encrypted as Hex.Hex)),
  )
  return new TextDecoder().decode(decrypted)
}

async function getAesKey(env: Pick<Env, 'SECRET_KEY'>, usages: ('decrypt' | 'encrypt')[]) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.SECRET_KEY))
  return await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, usages)
}

async function createCodeChallenge(codeVerifier: string) {
  return base64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))),
  )
}

function randomBase64Url(byteLength: number) {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

function base64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function hmacBase64(algorithm: 'SHA-1' | 'SHA-256', key: string, message: string) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { hash: algorithm, name: 'HMAC' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message)),
  )
  let binary = ''
  for (const byte of signature) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function oauthEncode(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
