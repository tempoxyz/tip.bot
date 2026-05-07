// Auto-generated from D1 database schema. Do not edit.

import type * as k from 'kysely'

export interface DB {
  account: Account
  connect_token: ConnectToken
  slack_installation: SlackInstallation
  tip: Tip
  tip_attempt: TipAttempt
  workspace: Workspace
}

type Account = {
  access_key_address: string | null
  access_key_authorization: string | null
  access_key_ciphertext: string | null
  access_key_expires_at: string | null
  created_at: k.Generated<string>
  display_name: string | null
  id: k.Generated<string>
  platform: k.Generated<string>
  platform_account_id: string
  tempo_address: string | null
  updated_at: k.Generated<string>
  workspace_id: string
}

type ConnectToken = {
  created_at: k.Generated<string>
  expires_at: string
  id: k.Generated<string>
  platform: k.Generated<string>
  platform_account_id: string
  token_hash: string
  used_at: string | null
  workspace_id: string
}

type SlackInstallation = {
  bot_token_ciphertext: string
  bot_user_id: string | null
  created_at: k.Generated<string>
  enterprise_id: string | null
  id: k.Generated<string>
  installed_by: string | null
  scopes: string | null
  team_id: string
  team_name: string | null
  updated_at: k.Generated<string>
  workspace_id: string
}

type Tip = {
  amount: string
  created_at: k.Generated<string>
  error: string | null
  id: k.Generated<string>
  idempotency_key: string
  reason: string | null
  recipient_account_id: string
  sender_account_id: string
  source_type: string
  status: string
  token_address: string
  tx_hash: string | null
  updated_at: k.Generated<string>
  workspace_id: string
}

type TipAttempt = {
  amount: string
  created_at: k.Generated<string>
  expires_at: string
  id: k.Generated<string>
  recipient_address: string
  sender_address: string
  tip_id: string
  token_address: string
}

type Workspace = {
  created_at: k.Generated<string>
  daily_cap: k.Generated<string>
  id: k.Generated<string>
  name: string | null
  platform: k.Generated<string>
  platform_team_id: string
  tip_amount: k.Generated<string>
  tip_emoji: k.Generated<string>
  updated_at: k.Generated<string>
}

export declare namespace DB {
  type Account = k.Selectable<DB['account']>
  type ConnectToken = k.Selectable<DB['connect_token']>
  type SlackInstallation = k.Selectable<DB['slack_installation']>
  type Tip = k.Selectable<DB['tip']>
  type TipAttempt = k.Selectable<DB['tip_attempt']>
  type Workspace = k.Selectable<DB['workspace']>

  export namespace Insertable {
    type Account = k.Insertable<DB['account']>
    type ConnectToken = k.Insertable<DB['connect_token']>
    type SlackInstallation = k.Insertable<DB['slack_installation']>
    type Tip = k.Insertable<DB['tip']>
    type TipAttempt = k.Insertable<DB['tip_attempt']>
    type Workspace = k.Insertable<DB['workspace']>
  }

  export namespace Selectable {
    type Account = k.Selectable<DB['account']>
    type ConnectToken = k.Selectable<DB['connect_token']>
    type SlackInstallation = k.Selectable<DB['slack_installation']>
    type Tip = k.Selectable<DB['tip']>
    type TipAttempt = k.Selectable<DB['tip_attempt']>
    type Workspace = k.Selectable<DB['workspace']>
  }

  export namespace Updateable {
    type Account = k.Updateable<DB['account']>
    type ConnectToken = k.Updateable<DB['connect_token']>
    type SlackInstallation = k.Updateable<DB['slack_installation']>
    type Tip = k.Updateable<DB['tip']>
    type TipAttempt = k.Updateable<DB['tip_attempt']>
    type Workspace = k.Updateable<DB['workspace']>
  }
}
