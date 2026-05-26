// Keep in sync with db/migrations/0008_reaction_tip_config.sql.
export const defaultReactionTipConfigs = [
  { amount: 1000, emoji: 'money_with_wings' }, // $0.001
  { amount: 10_000, emoji: 'dollar' }, // $0.01
  { amount: 100_000, emoji: 'moneybag' }, // $0.10
] as const
