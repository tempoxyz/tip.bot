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
      {
        email: slack.unconnectedUserEmail,
        name: slack.unconnectedUserName,
      },
    ],
  },
} as const satisfies SeedConfig
