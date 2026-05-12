// Auto-generated from D1 database schema. Do not edit.

import { z } from 'zod'

export const access_key = z.object({
  account_id: z.string(),
  address: z.string(),
  authorization: z.string(),
  ciphertext: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  id: z.string(),
  revoked_at: z.string().nullable(),
  updated_at: z.string(),
})

export const account = z.object({
  address: z.string(),
  created_at: z.string(),
  id: z.string(),
  updated_at: z.string(),
})

export const account_link_token = z.object({
  access_key_address: z.string(),
  access_key_authorization: z.string().nullable(),
  access_key_ciphertext: z.string(),
  access_key_expires_at: z.string(),
  access_key_public_key: z.string(),
  account_id: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
  id: z.string(),
  member_id: z.string(),
  provider_channel_id: z.string().nullable(),
  token_hash: z.string(),
  used_at: z.string().nullable(),
})

export const member = z.object({
  account_id: z.string().nullable(),
  created_at: z.string(),
  id: z.string(),
  login: z.string().nullable(),
  name: z.string().nullable(),
  provider_user_id: z.string(),
  updated_at: z.string(),
  workspace_id: z.string(),
})

export const tip = z.object({
  amount: z.number(),
  confirmed_at: z.string().nullable(),
  created_at: z.string(),
  failed_at: z.string().nullable(),
  failure_reason: z.string().nullable(),
  id: z.string(),
  idempotency_key: z.string(),
  memo: z.string().nullable(),
  recipient_id: z.string(),
  recipient_member_id: z.string(),
  sender_id: z.string(),
  sender_member_id: z.string(),
  token_address: z.string(),
  transaction_hash: z.string().nullable(),
  updated_at: z.string(),
  workspace_id: z.string(),
})

export const workspace = z.object({
  created_at: z.string(),
  default_amount: z.number(),
  default_token_address: z.string().nullable(),
  id: z.string(),
  name: z.string().nullable(),
  provider: z.literal('slack'),
  provider_id: z.string(),
  updated_at: z.string(),
})

export const db = {
  access_key: access_key,
  account: account,
  account_link_token: account_link_token,
  member: member,
  tip: tip,
  workspace: workspace,
}
