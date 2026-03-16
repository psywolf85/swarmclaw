# CLAUDE.md

### Keeping Instructions in Sync
- **`CLAUDE.md` and `AGENTS.md` must stay in sync.** When you add, edit, or remove a rule in one file, apply the same change to the other. They contain the same project guidelines — one for Claude Code, one for other coding agents.

### Dev Server
- **NEVER kill the dev server (`npm run dev`, port 3456) without asking the user first.** The user is often actively working against it, and other agents may be running tests against it. Always confirm before stopping, restarting, or killing the dev server process.

### Code Quality

**Lint baseline is a release gate.** Run `npm run lint:baseline` before any production release. The baseline must pass — no net-new lint fingerprints. If you fix existing violations, run `npm run lint:baseline:update` to lock in the improvement.

**Embrace TypeScript and the type system.** Use proper types, interfaces, and generics. Never use `any` — use `unknown`, `Record<string, unknown>`, or define a proper interface. The type system is there to catch bugs at compile time; circumventing it defeats the purpose.

**Lint rules exist to protect us.** Do not suppress, disable, or work around lint rules. Fix the underlying code instead. If a rule is genuinely wrong for the project, change the rule in the lint config with a clear justification — but this should be rare. The default is to fix the code, not silence the linter.

### Architecture

**Prefer simple, maintainable, reliable architectures.** Choose the straightforward approach over the clever one. Code that is easy to read, easy to debug, and easy to delete is better than code that is abstract, configurable, or "elegant." Avoid premature abstraction — three similar lines are better than a premature helper. Build for the current requirement, not hypothetical future ones.

### Testing

**Always test with live agents.** After making changes to chat execution, streaming, plugins, connectors, or any agent-facing code path, verify the work by running a live agent chat on the platform. Unit tests and type checks are necessary but not sufficient — the real test is whether an agent can actually hold a conversation, use its plugins, and produce correct results through the running application.
