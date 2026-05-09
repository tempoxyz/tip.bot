# AGENTS.md

> **Communication Style**: Be brief, concise. Maximize information density, minimize tokens. Incomplete sentences acceptable when clear. Remove filler words. Prioritize clarity over grammar.

## Commands

Prefer package scripts over ad-hoc `npx`. Use `pnpm`/`pnpx` for binaries.

- `pnpm check` - Lint and format with Vite+
- `pnpm db:codegen` - Generate Kysely database types and schemas
- `pnpm db:execute -- <SQL-or-flags>` - Run SQL against local D1
- `pnpm db:migrate` - Apply local D1 migrations
- `pnpm db:reset` - Reset local D1 state and re-run migrations
- `pnpm deps` - Check dependency updates with Taze
- `pnpm deps:ci` - Check GitHub Action updates with actions-up
- `pnpm gen:types` - Generate Cloudflare Worker binding types
- `pnpm slack:app manifest` - Generate Slack app manifest
- `pnpm slack:app validate` - Validate Slack app manifest
- `pnpm test` - Run Vitest projects
- `pnpm test:e2e` - Run Playwright E2E tests
- `pnpm check:types` - Type check all TS projects

## Debugging

- `pnpm dev` starts the app through Portless/Funnel for Slack callbacks.
- `pnpm dev:app` starts the app directly without Portless.
- Local D1 state lives in `.wrangler/state`; use `pnpm db:reset` when migrations or generated DB types drift.
- Use `pnpm db:execute -- --command "SQL"` for focused local D1 inspection.
- After changing Slack app configuration, run `pnpm slack:app validate` before updating production.

## API

- Always specify explicit status codes in `c.json()` responses (e.g. `c.json({ error: 'not_found' }, 404)`, `c.json({ data }, 200)`).
- Use string literal error codes in API responses for type-safe client matching.
- Prefer route-level error responses over global middleware errors so RPC types stay precise per endpoint.

## Cloudflare Workers

- Follow Workers best practices: https://developers.cloudflare.com/workers/best-practices/workers-best-practices/index.md
- Keep local binding state worktree-local unless explicitly sharing state.

## Database

- Run `pnpm db:codegen` after changing migrations.
- Use generated `DB` and schema types from `db/types.gen.ts` and `db/schemas.gen.ts` instead of hand-written record types.
- Use singular snake_case table and column names.
- Prefer timestamps like `deleted_at` over boolean lifecycle fields like `deleted`.
- Use CHECK constraints for enum-like text values where SQLite/D1 supports the invariant.

## Git Worktrees

For new agent sessions that may make code changes, prefer a dedicated git
worktree per session/thread. Examples include Amp threads, Claude sessions,
opencode sessions, or other concurrent coding agents.

Create worktrees with the pnpm worktree helper from the primary checkout:

```bash
pnpm worktree:new <branch-name|pr-number>
```

Use a separate branch/worktree so agents can edit files, run `pnpm install`, run
dev servers, and execute tests without interfering with the main checkout or
other agents. Use raw `git worktree` commands only if the pnpm helper is
unavailable.

This project is configured for worktree-friendly development:

- pnpm uses `enableGlobalVirtualStore: true` to share dependency storage across
  worktrees.
- `pnpm run dev` uses Portless, so each worktree gets a distinct `.localhost`
  URL.
- Cloudflare local binding state, including D1, lives in each worktree's
  `.wrangler/state` directory. Do not point multiple worktrees at the same local
  D1 state unless the user explicitly asks for shared state.

If you are already in a dedicated worktree, continue there. Do not create nested
worktrees. Read-only/question tasks do not need a worktree.

## Naming

- Avoid hyphens in command names, route paths, and identifiers — they break double-click-to-select

## Routing

- Prefer TanStack route masking for URL-backed `Dialog` flows instead of search-param/local-state dialog toggles when the dialog is page-local and benefits from deep-linking/reload support

## Code Style

- Component/page component should be the first thing in the file (after imports)
- Use IIFE when appropriate
- No braces for single-branch statements (`if (true) return ...`)
- No ellipsis in button text (e.g. "Deleting" not "Deleting...")
- No emoji
- Alphabetize imports, keys, props, etc.
- Inline code; extract only when reused across files
- Use `#` package.json import prefix (e.g., `#lib/auth.ts`, `#db/client.ts`)
- Use `.ts`/`.tsx` extensions in imports (`allowImportingTsExtensions`)
- Place internal non-exported functions at the bottom of the file
- Prefer "account" over "user" in naming (variables, types, functions, etc.)
- Don't destructure unless necessary (e.g. prefer `const json = c.req.valid('json')` over `const { name, slug } = c.req.valid('json')`)
- Avoid creating variables for basic things unless necessary (e.g. prefer using `c.var.db` over `const db = c.var.db`)
- Use rpc $url() method for type-safe url generation instead of hardcoding strings
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

## pnpm Security Exclusions

This project uses strict pnpm security settings, including
`minimumReleaseAgeStrict: true` and an explicit `allowBuilds` list. If pnpm
blocks an install because a locked dependency is too new, add the narrowest
possible `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml`.

Prefer exact `name@version` exclusions for packages already resolved in the
lockfile. Avoid broad package patterns unless the package family is intentionally
managed together and the tradeoff is documented next to the exclusion.
