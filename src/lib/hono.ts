import { zValidator } from '@hono/zod-validator'
import type { Context, ValidationTargets } from 'hono'
import type { z } from 'zod'

function validationHook(
  result: {
    error?: { issues: { message: string; path: PropertyKey[] }[] }
    success: boolean
  },
  c: Context,
) {
  if (!result.success)
    return c.json(
      {
        code: 'validation_error',
        message: 'Validation failed',
        issues: result.error?.issues.map((issue) => ({
          message: issue.message,
          path: issue.path.join('.'),
        })),
      },
      400,
    )
}

export const validator = ((target: keyof ValidationTargets, schema: z.ZodType) =>
  zValidator(target, schema, validationHook)) as typeof zValidator
