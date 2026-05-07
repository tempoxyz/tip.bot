// Auto-generated from D1 database schema. Do not edit.

import { z } from 'zod'

export const account = z.object({
  access_key_address: z.string().nullable(),
  access_key_authorization: z.string().nullable(),
  access_key_ciphertext: z.string().nullable(),
  access_key_expires_at: z.string().nullable(),
  created_at: z.string(),
  display_name: z.string().nullable(),
  id: z.string(),
  platform: z.string(),
  platform_account_id: z.string(),
  tempo_address: z.string().nullable(),
  updated_at: z.string(),
  workspace_id: z.string(),
})

export const connect_token = z.object({
  created_at: z.string(),
  expires_at: z.string(),
  id: z.string(),
  platform: z.string(),
  platform_account_id: z.string(),
  token_hash: z.string(),
  used_at: z.string().nullable(),
  workspace_id: z.string(),
})

export const tip = z.object({
  amount: z.string(),
  created_at: z.string(),
  error: z.string().nullable(),
  id: z.string(),
  idempotency_key: z.string(),
  reason: z.string().nullable(),
  recipient_account_id: z.string(),
  sender_account_id: z.string(),
  source_type: z.string(),
  status: z.string(),
  token_address: z.string(),
  tx_hash: z.string().nullable(),
  updated_at: z.string(),
  workspace_id: z.string(),
})

export const tip_attempt = z.object({
  amount: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  id: z.string(),
  recipient_address: z.string(),
  sender_address: z.string(),
  tip_id: z.string(),
  token_address: z.string(),
})

export const workspace = z.object({
  created_at: z.string(),
  daily_cap: z.string(),
  id: z.string(),
  name: z.string().nullable(),
  platform: z.string(),
  platform_team_id: z.string(),
  tip_amount: z.string(),
  tip_emoji: z.string(),
  updated_at: z.string(),
})

export const db = {
  account: account,
  connect_token: connect_token,
  tip: tip,
  tip_attempt: tip_attempt,
  workspace: workspace,
}
