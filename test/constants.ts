import type { SeedConfig } from 'emulate'

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
} as const

export const seed = {
  slack: {
    team: {
      domain: slack.teamDomain,
      name: slack.teamName,
    },
    users: [
      {
        email: slack.memberUserEmail,
        name: slack.memberUserName,
      },
    ],
  },
} as const satisfies SeedConfig
