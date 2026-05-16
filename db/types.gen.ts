// Auto-generated from D1 database schema. Do not edit.

import type * as k from 'kysely'

export interface DB {
  access_key: access_key
  account: account
  account_link_token: account_link_token
  member: member
  provider_identity: provider_identity
  reaction_tip: reaction_tip
  reaction_tip_thread: reaction_tip_thread
  tip: tip
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
  created_at: k.Generated<string>
  expires_at: string
  id: string
  member_id: string
  provider_channel_id: string | null
  token_hash: string
  used_at: string | null
}

type member = {
  account_id: string | null
  created_at: k.Generated<string>
  id: string
  login: string | null
  name: string | null
  provider_identity_id: string | null
  provider_user_id: string
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

type reaction_tip_thread = {
  channel_id: string
  created_at: k.Generated<string>
  id: string
  message_ts: string
  reaction: string
  reply_ts: string
  updated_at: k.Generated<string>
  workspace_id: string
}

type tip = {
  access_key_id: string | null
  amount: number
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
  transaction_hash: string | null
  updated_at: k.Generated<string>
  workspace_id: string
}

type workspace = {
  chain_id: k.Generated<number>
  created_at: k.Generated<string>
  default_amount: k.Generated<number>
  default_token_address: string | null
  id: string
  name: string | null
  provider: k.Generated<'slack'>
  provider_id: string
  reaction_tip_emoji: k.Generated<string>
  updated_at: k.Generated<string>
}

export declare namespace DB {
  type access_key = k.Selectable<DB['access_key']>
  type account = k.Selectable<DB['account']>
  type account_link_token = k.Selectable<DB['account_link_token']>
  type member = k.Selectable<DB['member']>
  type provider_identity = k.Selectable<DB['provider_identity']>
  type reaction_tip = k.Selectable<DB['reaction_tip']>
  type reaction_tip_thread = k.Selectable<DB['reaction_tip_thread']>
  type tip = k.Selectable<DB['tip']>
  type workspace = k.Selectable<DB['workspace']>

  export namespace Insertable {
    type access_key = k.Insertable<DB['access_key']>
    type account = k.Insertable<DB['account']>
    type account_link_token = k.Insertable<DB['account_link_token']>
    type member = k.Insertable<DB['member']>
    type provider_identity = k.Insertable<DB['provider_identity']>
    type reaction_tip = k.Insertable<DB['reaction_tip']>
    type reaction_tip_thread = k.Insertable<DB['reaction_tip_thread']>
    type tip = k.Insertable<DB['tip']>
    type workspace = k.Insertable<DB['workspace']>
  }

  export namespace Selectable {
    type access_key = k.Selectable<DB['access_key']>
    type account = k.Selectable<DB['account']>
    type account_link_token = k.Selectable<DB['account_link_token']>
    type member = k.Selectable<DB['member']>
    type provider_identity = k.Selectable<DB['provider_identity']>
    type reaction_tip = k.Selectable<DB['reaction_tip']>
    type reaction_tip_thread = k.Selectable<DB['reaction_tip_thread']>
    type tip = k.Selectable<DB['tip']>
    type workspace = k.Selectable<DB['workspace']>
  }

  export namespace Updateable {
    type access_key = k.Updateable<DB['access_key']>
    type account = k.Updateable<DB['account']>
    type account_link_token = k.Updateable<DB['account_link_token']>
    type member = k.Updateable<DB['member']>
    type provider_identity = k.Updateable<DB['provider_identity']>
    type reaction_tip = k.Updateable<DB['reaction_tip']>
    type reaction_tip_thread = k.Updateable<DB['reaction_tip_thread']>
    type tip = k.Updateable<DB['tip']>
    type workspace = k.Updateable<DB['workspace']>
  }
}
