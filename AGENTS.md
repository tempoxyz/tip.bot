# AGENTS.md

> **Communication Style**: Be brief, concise. Maximize information density, minimize tokens. Incomplete sentences acceptable when clear. Remove filler words. Prioritize clarity over grammar.

## Workflow

Run the following to verify changes:

```sh
pnpm check
pnpm check:types
pnpm test
pnpm test:e2e
```

If a test fails, run it in isolation and gradually expand out to more tests as you gain confidence.

## Database

- Run `pnpm db:codegen` after changing migrations.
- Use generated `DB` and schema types from `db/types.gen.ts` and `db/schemas.gen.ts` instead of hand-written record types.
- Use singular snake_case table and column names.
- Prefer timestamps like `deleted_at` over boolean lifecycle fields like `deleted`.
- Use CHECK constraints for enum-like text values where SQLite/D1 supports the invariant.

## Naming

- Avoid hyphens in command names, route paths, and identifiers — they break double-click-to-select

## Routing

- Prefer TanStack route masking for URL-backed `Dialog` flows instead of search-param/local-state dialog toggles when the dialog is page-local and benefits from deep-linking/reload support
- Use inline zod/mini schema for `validateSearch`

## Code Style

- Component/page component should be the first thing in the file (after imports)
- Use IIFE when appropriate. Better to iife with comments than create low/single-use functions/consts.
- No braces for single-branch statements (`if (true) return ...`)
- No ellipsis in button text (e.g. "Deleting" not "Deleting...")
- No emoji
- Use React namespace import `import * as React from 'react'`, then `React.useEffect`
- Alphabetize imports, keys, props, etc.
- Inline code; extract only when reused across files
- Use `#` package.json import prefix (e.g., `#lib/auth.ts`, `#db/client.ts`)
- Use `.ts`/`.tsx` extensions in imports (`allowImportingTsExtensions`)
- Place internal non-exported functions at the bottom of the file
- Prefer "account" over "user" in naming (variables, types, functions, etc.)
- Don't destructure unless necessary (e.g. prefer `const json = c.req.valid('json')` over `const { name, slug } = c.req.valid('json')`)
- Avoid creating variables for basic things unless necessary (e.g. prefer using `c.var.db` over `const db = c.var.db`)
- whenever you add a time duration/amount, make sure it has comment next to it with the human-readable time (e.g. `const accessTokenTtlMs = 15 * 60 * 1000 // 15 minutes`)

## Tests

- Don't use `describe` blocks unless required

## React Components

- Type `Props` MUST be inlined unless used elsewhere
- Do NOT destructure props in the function signature; destructure on the next line instead
  - Bad: `function MyComponent({ foo, bar }: { foo: string; bar: number }) { ... }`
  - Good: `function MyComponent(props: { foo: string; bar: number }) { const { foo, bar } = props; ... }`
- Server functions should go below component
- Use `React.PropsWithChildren` over `{ children: React.ReactNode }`
- **Shared components** use namespace pattern: define private functions, export a single const object (e.g., `export const Nav = { Group, Logo, Root, Skip }`). Import as `import { Nav } from '#components/Nav.tsx'`, use as `<Nav.Root>`. See `Dialog.tsx`, `Dashboard.tsx`, `Nav.tsx` for examples.

## UI

- **Icons** - Auto-imported via unplugin-icons. Use `<Icon{Collection}{Name} />` (e.g., `<IconLucideArrowRight />`, `<IconOcticonMarkGithub />`).
- Icon-only interactive elements must have an accessible name (`aria-label`, `aria-labelledby`, or visible text), including pagination and overflow/menu buttons.
- When adding a custom `focus-visible` ring or inset focus treatment, explicitly disable the global outline for that element/scope so focus styles do not render twice.
- **Tailwind CSS v4** - Use `@import "tailwindcss"` in CSS; utility classes in components
  - Do NOT use inline styles (`style={...}`) for styling when Tailwind can express it; use `className` utilities and `data-*` variants instead
  - Use logical properties for RTL/LTR support (e.g. `ms-4`/`me-4` instead of `ml-4`/`mr-4`, `start-2`/`end-2` instead of `left-2`/`right-2`)
  - Do NOT concatenate class names for conditional styles. Use `data-*` attributes with Tailwind's `data-[...]` variant instead (e.g., `data-[active]:bg-blue9` + `data-active={cond ? '' : undefined}`)

## Misc

- Repo/project-level README is located at `.github/README.md`
- Use `pnpm-workspace.yaml>overrides` instead of `package.json#pnpm.overrides`
- `.env` is used instead of `.dev.vars`
- Use `.github/TODO.md` for general TODOs not attached to specific files/lines
- Make sure comments don't get dropped from `pnpm-workspace.yaml` when making edits or fixing `pnpm audit`
