// Auto-generated from D1 database schema. Do not edit.

import type * as k from 'kysely'

export interface DB {
  access_key: access_key
  account: account
  account_link_token: account_link_token
  member: member
  pending_tip: pending_tip
  provider_identity: provider_identity
  provider_link_challenge: provider_link_challenge
  provider_link_oauth_state: provider_link_oauth_state
  reaction_tip: reaction_tip
  reaction_tip_config: reaction_tip_config
  reaction_tip_thread: reaction_tip_thread
  receipt_boost_thread: receipt_boost_thread
  tip: tip
  tip_ask: tip_ask
  tip_batch: tip_batch
  tip_raffle: tip_raffle
  tip_raffle_ticket: tip_raffle_ticket
  tip_receipt_message: tip_receipt_message
  workspace: workspace
}

type access_key = {
  account_id: string
  address: string
  authorization: string
  authorization_used_at: string | null
  chain_id: k.Generated<number>
  ciphertext: string
  created_at: k.Generated<string>
  expires_at: string
  id: string
  revoked_at: string | null
  token_address: string | null
  updated_at: k.Generated<string>
}

type account = {
  address: string
  created_at: k.Generated<string>
  id: string
  updated_at: k.Generated<string>
}

type account_link_token = {
  access_key_address: string
  access_key_authorization: string | null
  access_key_ciphertext: string
  access_key_expires_at: string
  access_key_public_key: string
  account_id: string | null
  channel_provider_id: string | null
  created_at: k.Generated<string>
  expires_at: string
  id: string
  member_id: string
  provider_channel_id: string | null
  token_hash: string
  used_at: string | null
}

type member = {
  created_at: k.Generated<string>
  id: string
  login: string | null
  name: string | null
  provider_identity_id: string
  provider_user_id: string
  updated_at: k.Generated<string>
  workspace_id: string
}

type pending_tip = {
  access_key_id: string | null
  amount: number
  chain_id: number
  created_at: k.Generated<string>
  expires_at: string
  failure_reason: string | null
  id: string
  idempotency_key: string
  memo: string | null
  provider: k.Generated<'slack'>
  provider_channel_id: string
  provider_id: string
  provider_message_ts: string | null
  provider_thread_id: string | null
  recipient_member_id: string
  recipient_provider_user_id: string
  sender_id: string
  sender_member_id: string
  sender_provider_user_id: string
  source: 'command' | 'mention' | 'reaction'
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'expired'
  tip_id: string | null
  token_address: string
  updated_at: k.Generated<string>
  workspace_id: string
}

type provider_identity = {
  account_id: string | null
  created_at: k.Generated<string>
  display_name: string | null
  id: string
  metadata: string | null
  provider: 'slack'
  provider_global_user_id: string | null
  provider_user_id: string
  provider_workspace_id: string | null
  real_name: string | null
  updated_at: k.Generated<string>
}

type provider_link_challenge = {
  access_key_address: string
  access_key_authorization: string | null
  access_key_ciphertext: string
  access_key_expires_at: string
  access_key_public_key: string
  account_id: string | null
  created_at: k.Generated<string>
  expected_provider_handle: string | null
  expected_provider_user_id: string | null
  expires_at: string
  id: string
  proof_hash: string | null
  provider: 'twitter'
  provider_handle: string | null
  provider_user_id: string | null
  tweet_id: string | null
  updated_at: k.Generated<string>
  used_at: string | null
  wallet_address: string
}

type provider_link_oauth_state = {
  challenge_id: string
  code_verifier_ciphertext: string
  created_at: string
  expires_at: string
  id: string
  state_hash: string
  updated_at: string
  used_at: string | null
}

type reaction_tip = {
  channel_id: string
  created_at: k.Generated<string>
  id: string
  idempotency_key: string
  message_ts: string
  reaction: string
  recipient_member_id: string
  sender_member_id: string
  thread_ts: string
  tip_id: string | null
  updated_at: k.Generated<string>
  workspace_id: string
}

type reaction_tip_config = {
  amount: number
  created_at: k.Generated<string>
  emoji: string
  id: string
  updated_at: k.Generated<string>
  workspace_id: string
}

type reaction_tip_thread = {
  channel_id: string
  created_at: k.Generated<string>
  id: string
  message_ts: string
  reply_ts: string
  updated_at: k.Generated<string>
  workspace_id: string
}

type receipt_boost_thread = {
  channel_id: string
  created_at: k.Generated<string>
  id: string
  reply_ts: string
  thread_ts: string
  updated_at: k.Generated<string>
  workspace_id: string
}

type tip = {
  access_key_id: string | null
  amount: number
  batch_id: string | null
  chain_id: k.Generated<number>
  confirmed_at: string | null
  created_at: k.Generated<string>
  failed_at: string | null
  failure_reason: string | null
  id: string
  idempotency_key: string
  memo: string | null
  recipient_id: string
  recipient_member_id: string
  sender_id: string
  sender_member_id: string
  sponsorship_memo: string | null
  token_address: string
  transfer_log_index: number | null
  updated_at: k.Generated<string>
  workspace_id: string
}

type tip_ask = {
  beneficiary_provider_user_id: string | null
  chain_id: number
  closed_at: string | null
  created_at: k.Generated<string>
  creator_fee_basis_points: k.Generated<number>
  dollar_amount: number
  id: string
  memo: string | null
  money_with_wings_amount: number
  moneybag_amount: number
  provider_channel_id: string
  provider_id: string
  provider_message_ts: string
  requester_member_id: string
  token_address: string
  updated_at: k.Generated<string>
  workspace_id: string
}

type tip_batch = {
  amount_each: number
  created_at: k.Generated<string>
  failure_reason: string | null
  id: string
  idempotency_key: string
  memo: string | null
  provider: k.Generated<'slack'>
  provider_channel_id: string
  provider_id: string
  provider_thread_id: string | null
  recipient_count: number
  sender_member_id: string
  source: k.Generated<'command' | 'mention' | 'reaction' | 'migration'>
  status: 'pending' | 'needs_confirmation' | 'submitting' | 'confirmed' | 'failed' | 'canceled'
  token_address: string
  total_amount: number
  transaction_hash: string | null
  updated_at: k.Generated<string>
  workspace_id: string
}

type tip_raffle = {
  chain_id: number
  created_at: k.Generated<string>
  creator_member_id: string
  ended_at: string | null
  ends_at: string
  failed_ticket_count: k.Generated<number>
  id: string
  memo: string
  provider_channel_id: string
  provider_id: string
  provider_message_ts: string
  settled_amount: k.Generated<number>
  status: 'open' | 'settling' | 'ended'
  ticket_amount: number
  token_address: string
  updated_at: k.Generated<string>
  winner_member_id: string | null
  winning_ticket_number: number | null
  workspace_id: string
}

type tip_raffle_ticket = {
  buyer_member_id: string
  created_at: k.Generated<string>
  id: string
  idempotency_key: string
  raffle_id: string
  ticket_count: number
  updated_at: k.Generated<string>
}

type tip_receipt_message = {
  channel_id: string
  created_at: k.Generated<string>
  id: string
  message_ts: string
  thread_ts: string
  tip_batch_id: string
  updated_at: k.Generated<string>
  workspace_id: string
}

type workspace = {
  chain_id: k.Generated<number>
  created_at: k.Generated<string>
  default_amount: k.Generated<number>
  default_token_address: string | null
  id: string
  installed_at: string | null
  name: string | null
  provider: k.Generated<'slack'>
  provider_id: string
  uninstalled_at: string | null
  updated_at: k.Generated<string>
}

export declare namespace DB {
  type access_key = k.Selectable<DB['access_key']>
  type account = k.Selectable<DB['account']>
  type account_link_token = k.Selectable<DB['account_link_token']>
  type member = k.Selectable<DB['member']>
  type pending_tip = k.Selectable<DB['pending_tip']>
  type provider_identity = k.Selectable<DB['provider_identity']>
  type provider_link_challenge = k.Selectable<DB['provider_link_challenge']>
  type provider_link_oauth_state = k.Selectable<DB['provider_link_oauth_state']>
  type reaction_tip = k.Selectable<DB['reaction_tip']>
  type reaction_tip_config = k.Selectable<DB['reaction_tip_config']>
  type reaction_tip_thread = k.Selectable<DB['reaction_tip_thread']>
  type receipt_boost_thread = k.Selectable<DB['receipt_boost_thread']>
  type tip = k.Selectable<DB['tip']>
  type tip_ask = k.Selectable<DB['tip_ask']>
  type tip_batch = k.Selectable<DB['tip_batch']>
  type tip_raffle = k.Selectable<DB['tip_raffle']>
  type tip_raffle_ticket = k.Selectable<DB['tip_raffle_ticket']>
  type tip_receipt_message = k.Selectable<DB['tip_receipt_message']>
  type workspace = k.Selectable<DB['workspace']>

  export namespace Insertable {
    type access_key = k.Insertable<DB['access_key']>
    type account = k.Insertable<DB['account']>
    type account_link_token = k.Insertable<DB['account_link_token']>
    type member = k.Insertable<DB['member']>
    type pending_tip = k.Insertable<DB['pending_tip']>
    type provider_identity = k.Insertable<DB['provider_identity']>
    type provider_link_challenge = k.Insertable<DB['provider_link_challenge']>
    type provider_link_oauth_state = k.Insertable<DB['provider_link_oauth_state']>
    type reaction_tip = k.Insertable<DB['reaction_tip']>
    type reaction_tip_config = k.Insertable<DB['reaction_tip_config']>
    type reaction_tip_thread = k.Insertable<DB['reaction_tip_thread']>
    type receipt_boost_thread = k.Insertable<DB['receipt_boost_thread']>
    type tip = k.Insertable<DB['tip']>
    type tip_ask = k.Insertable<DB['tip_ask']>
    type tip_batch = k.Insertable<DB['tip_batch']>
    type tip_raffle = k.Insertable<DB['tip_raffle']>
    type tip_raffle_ticket = k.Insertable<DB['tip_raffle_ticket']>
    type tip_receipt_message = k.Insertable<DB['tip_receipt_message']>
    type workspace = k.Insertable<DB['workspace']>
  }

  export namespace Selectable {
    type access_key = k.Selectable<DB['access_key']>
    type account = k.Selectable<DB['account']>
    type account_link_token = k.Selectable<DB['account_link_token']>
    type member = k.Selectable<DB['member']>
    type pending_tip = k.Selectable<DB['pending_tip']>
    type provider_identity = k.Selectable<DB['provider_identity']>
    type provider_link_challenge = k.Selectable<DB['provider_link_challenge']>
    type provider_link_oauth_state = k.Selectable<DB['provider_link_oauth_state']>
    type reaction_tip = k.Selectable<DB['reaction_tip']>
    type reaction_tip_config = k.Selectable<DB['reaction_tip_config']>
    type reaction_tip_thread = k.Selectable<DB['reaction_tip_thread']>
    type receipt_boost_thread = k.Selectable<DB['receipt_boost_thread']>
    type tip = k.Selectable<DB['tip']>
    type tip_ask = k.Selectable<DB['tip_ask']>
    type tip_batch = k.Selectable<DB['tip_batch']>
    type tip_raffle = k.Selectable<DB['tip_raffle']>
    type tip_raffle_ticket = k.Selectable<DB['tip_raffle_ticket']>
    type tip_receipt_message = k.Selectable<DB['tip_receipt_message']>
    type workspace = k.Selectable<DB['workspace']>
  }

  export namespace Updateable {
    type access_key = k.Updateable<DB['access_key']>
    type account = k.Updateable<DB['account']>
    type account_link_token = k.Updateable<DB['account_link_token']>
    type member = k.Updateable<DB['member']>
    type pending_tip = k.Updateable<DB['pending_tip']>
    type provider_identity = k.Updateable<DB['provider_identity']>
    type provider_link_challenge = k.Updateable<DB['provider_link_challenge']>
    type provider_link_oauth_state = k.Updateable<DB['provider_link_oauth_state']>
    type reaction_tip = k.Updateable<DB['reaction_tip']>
    type reaction_tip_config = k.Updateable<DB['reaction_tip_config']>
    type reaction_tip_thread = k.Updateable<DB['reaction_tip_thread']>
    type receipt_boost_thread = k.Updateable<DB['receipt_boost_thread']>
    type tip = k.Updateable<DB['tip']>
    type tip_ask = k.Updateable<DB['tip_ask']>
    type tip_batch = k.Updateable<DB['tip_batch']>
    type tip_raffle = k.Updateable<DB['tip_raffle']>
    type tip_raffle_ticket = k.Updateable<DB['tip_raffle_ticket']>
    type tip_receipt_message = k.Updateable<DB['tip_receipt_message']>
    type workspace = k.Updateable<DB['workspace']>
  }
}
