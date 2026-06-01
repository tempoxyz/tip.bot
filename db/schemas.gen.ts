// Auto-generated from D1 database schema. Do not edit.

import { z } from 'zod'

export const access_key = z.object({
  account_id: z.string(),
  address: z.string(),
  authorization: z.string(),
  authorization_used_at: z.string().nullable(),
  chain_id: z.number(),
  ciphertext: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  id: z.string(),
  revoked_at: z.string().nullable(),
  token_address: z.string().nullable(),
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
  channel_provider_id: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
  id: z.string(),
  member_id: z.string(),
  provider_channel_id: z.string().nullable(),
  token_hash: z.string(),
  used_at: z.string().nullable(),
})

export const member = z.object({
  created_at: z.string(),
  id: z.string(),
  login: z.string().nullable(),
  name: z.string().nullable(),
  provider_identity_id: z.string(),
  provider_user_id: z.string(),
  updated_at: z.string(),
  workspace_id: z.string(),
})

export const pending_tip = z.object({
  access_key_id: z.string().nullable(),
  amount: z.number(),
  chain_id: z.number(),
  created_at: z.string(),
  expires_at: z.string(),
  failure_reason: z.string().nullable(),
  id: z.string(),
  idempotency_key: z.string(),
  memo: z.string().nullable(),
  provider: z.literal('slack'),
  provider_channel_id: z.string(),
  provider_id: z.string(),
  provider_message_ts: z.string().nullable(),
  provider_thread_id: z.string().nullable(),
  recipient_member_id: z.string(),
  recipient_provider_user_id: z.string(),
  sender_id: z.string(),
  sender_member_id: z.string(),
  sender_provider_user_id: z.string(),
  source: z.enum(['command', 'mention', 'reaction']),
  status: z.enum(['pending', 'sending', 'sent', 'failed', 'expired']),
  tip_id: z.string().nullable(),
  token_address: z.string(),
  updated_at: z.string(),
  workspace_id: z.string(),
})

export const provider_identity = z.object({
  account_id: z.string().nullable(),
  created_at: z.string(),
  display_name: z.string().nullable(),
  id: z.string(),
  metadata: z.string().nullable(),
  provider: z.literal('slack'),
  provider_global_user_id: z.string().nullable(),
  provider_user_id: z.string(),
  provider_workspace_id: z.string().nullable(),
  real_name: z.string().nullable(),
  updated_at: z.string(),
})

export const provider_link_challenge = z.object({
  access_key_address: z.string(),
  access_key_authorization: z.string().nullable(),
  access_key_ciphertext: z.string(),
  access_key_expires_at: z.string(),
  access_key_public_key: z.string(),
  account_id: z.string().nullable(),
  created_at: z.string(),
  expected_provider_handle: z.string().nullable(),
  expected_provider_user_id: z.string().nullable(),
  expires_at: z.string(),
  id: z.string(),
  proof_hash: z.string().nullable(),
  provider: z.literal('twitter'),
  provider_handle: z.string().nullable(),
  provider_user_id: z.string().nullable(),
  tweet_id: z.string().nullable(),
  updated_at: z.string(),
  used_at: z.string().nullable(),
  wallet_address: z.string(),
})

export const provider_link_oauth_state = z.object({
  challenge_id: z.string(),
  code_verifier_ciphertext: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  id: z.string(),
  state_hash: z.string(),
  updated_at: z.string(),
  used_at: z.string().nullable(),
})

export const reaction_tip = z.object({
  channel_id: z.string(),
  created_at: z.string(),
  id: z.string(),
  idempotency_key: z.string(),
  message_ts: z.string(),
  reaction: z.string(),
  recipient_member_id: z.string(),
  sender_member_id: z.string(),
  thread_ts: z.string(),
  tip_id: z.string().nullable(),
  updated_at: z.string(),
  workspace_id: z.string(),
})

export const reaction_tip_config = z.object({
  amount: z.number(),
  created_at: z.string(),
  emoji: z.string(),
  id: z.string(),
  updated_at: z.string(),
  workspace_id: z.string(),
})

export const reaction_tip_thread = z.object({
  channel_id: z.string(),
  created_at: z.string(),
  id: z.string(),
  message_ts: z.string(),
  reply_ts: z.string(),
  updated_at: z.string(),
  workspace_id: z.string(),
})

export const receipt_boost_thread = z.object({
  channel_id: z.string(),
  created_at: z.string(),
  id: z.string(),
  reply_ts: z.string(),
  thread_ts: z.string(),
  updated_at: z.string(),
  workspace_id: z.string(),
})

export const tip = z.object({
  access_key_id: z.string().nullable(),
  amount: z.number(),
  batch_id: z.string().nullable(),
  chain_id: z.number(),
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
  sponsorship_memo: z.string().nullable(),
  token_address: z.string(),
  transfer_log_index: z.number().nullable(),
  updated_at: z.string(),
  workspace_id: z.string(),
})

export const tip_batch = z.object({
  amount_each: z.number(),
  created_at: z.string(),
  failure_reason: z.string().nullable(),
  id: z.string(),
  idempotency_key: z.string(),
  memo: z.string().nullable(),
  provider: z.literal('slack'),
  provider_channel_id: z.string(),
  provider_id: z.string(),
  provider_thread_id: z.string().nullable(),
  recipient_count: z.number(),
  sender_member_id: z.string(),
  source: z.enum(['command', 'mention', 'reaction', 'migration']),
  status: z.enum([
    'pending',
    'needs_confirmation',
    'submitting',
    'confirmed',
    'failed',
    'canceled',
  ]),
  token_address: z.string(),
  total_amount: z.number(),
  transaction_hash: z.string().nullable(),
  updated_at: z.string(),
  workspace_id: z.string(),
})

export const tip_receipt_message = z.object({
  channel_id: z.string(),
  created_at: z.string(),
  id: z.string(),
  message_ts: z.string(),
  thread_ts: z.string(),
  tip_batch_id: z.string(),
  updated_at: z.string(),
  workspace_id: z.string(),
})

export const workspace = z.object({
  chain_id: z.number(),
  created_at: z.string(),
  default_amount: z.number(),
  default_token_address: z.string().nullable(),
  id: z.string(),
  installed_at: z.string().nullable(),
  name: z.string().nullable(),
  provider: z.literal('slack'),
  provider_id: z.string(),
  uninstalled_at: z.string().nullable(),
  updated_at: z.string(),
})

export const db = {
  access_key: access_key,
  account: account,
  account_link_token: account_link_token,
  member: member,
  pending_tip: pending_tip,
  provider_identity: provider_identity,
  provider_link_challenge: provider_link_challenge,
  provider_link_oauth_state: provider_link_oauth_state,
  reaction_tip: reaction_tip,
  reaction_tip_config: reaction_tip_config,
  reaction_tip_thread: reaction_tip_thread,
  receipt_boost_thread: receipt_boost_thread,
  tip: tip,
  tip_batch: tip_batch,
  tip_receipt_message: tip_receipt_message,
  workspace: workspace,
}
