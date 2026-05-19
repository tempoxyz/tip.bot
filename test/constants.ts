import type { SeedConfig } from 'emulate'

export const tip = {
  recipientRootPrivateKey: '0x19d1b9afaf5b1f79f708bd95673df2203213fdbbdafe50e70f056c2fecaa799e',
  senderRootPrivateKey: '0x7797c0f3db8b946604ec2039dfd9763e4ffdc53174342a2ed9b14fa3eda666a5',
} as const

export const slack = {
  adminUserEmail: 'admin@emulate.dev',
  adminUserId: 'U000000001',
  adminUserName: 'admin',
  botToken: 'xoxb-test',
  botUserId: 'B000000001',
  channelId: 'C000000001',
  memberUserEmail: 'member@example.com',
  memberUserId: 'U000000002',
  memberUserName: 'member',
  missingChannelId: 'C000000404',
  missingUserId: 'U000000404',
  teamDomain: 'emulate',
  teamId: 'T000000001',
  teamName: 'Emulate',
  unconnectedUserEmail: 'unconnected@example.com',
  unconnectedUserName: 'unconnected',
} as const

export const slackConnect = {
  channelId: 'C0000000SC',
  channelName: 'slackconnect',
  enterpriseId: 'E0000000SC',
  teamBotToken: 'xoxb-connect',
  teamBotUserId: 'B0000000SC',
  teamDomain: 'connect',
  teamId: 'T0000000SC',
  teamName: 'Connect',
  userEmail: 'connect@example.com',
  userId: 'U0000000SC',
  userName: 'connect',
} as const

const slackScopes = [
  'app_mentions:read',
  'assistant:write',
  'channels:history',
  'channels:read',
  'chat:write',
  'commands',
  'emoji:read',
  'groups:history',
  'groups:read',
  'reactions:read',
  'users:read',
]

export const seed = {
  slack: {
    channels: [
      {
        channel_id: slackConnect.channelId,
        context_team_id: slack.teamId,
        conversation_host_id: slackConnect.enterpriseId,
        is_ext_shared: true,
        is_shared: true,
        name: slackConnect.channelName,
        shared_team_ids: [slackConnect.teamId],
        team_id: slack.teamId,
      },
    ],
    team: {
      domain: slack.teamDomain,
      name: slack.teamName,
    },
    teams: [
      {
        domain: slackConnect.teamDomain,
        name: slackConnect.teamName,
        team_id: slackConnect.teamId,
      },
    ],
    users: [
      {
        email: slack.memberUserEmail,
        name: slack.memberUserName,
      },
      {
        email: slackConnect.userEmail,
        enterprise_id: slackConnect.enterpriseId,
        name: slackConnect.userName,
        team_id: slackConnect.teamId,
        user_id: slackConnect.userId,
      },
      {
        email: slack.unconnectedUserEmail,
        name: slack.unconnectedUserName,
      },
    ],
  },
  tokens: {
    admin: { login: slack.adminUserId, scopes: slackScopes },
    member: { login: slack.memberUserId, scopes: slackScopes },
    [slack.adminUserId]: { login: slack.adminUserId, scopes: slackScopes },
    [slack.memberUserId]: { login: slack.memberUserId, scopes: slackScopes },
    [slack.botToken]: { login: slack.adminUserId, scopes: slackScopes },
    [slackConnect.teamBotToken]: { login: slackConnect.userId, scopes: slackScopes },
  },
} as const satisfies SeedConfig
