import { customAlphabet } from 'nanoid'

// NOTE: Do not change these values without coordinating URL and DB usage.
export const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
export const defaultSize = 12 // https://zelark.github.io/nano-id-cc

export const generate = customAlphabet(alphabet, defaultSize)
