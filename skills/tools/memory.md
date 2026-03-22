# Memory Tool

Persistent knowledge storage across conversations. Store facts, preferences, context, and decisions so they survive beyond the current session.

## Memory Tiers

| Tier | Scope | Lifetime | Use For |
|------|-------|----------|---------|
| **Working** | Current session | Session duration | Scratch notes, intermediate results, task state |
| **Durable** | Cross-session | Permanent until deleted | User preferences, project facts, learned patterns |
| **Archive** | Cross-session | Permanent, lower priority | Completed task summaries, historical context |

## Actions

| Action | Description | Key Parameters |
|--------|-------------|----------------|
| `store` | Save a new memory | `title`, `value`, `category` |
| `search` | Find memories by query | `query`, `scope` (optional) |
| `get` | Retrieve a specific memory | `id` or `key` |
| `update` | Modify an existing memory | `id`, `value` (and/or `title`, `category`) |

## Store

```json
{
  "action": "store",
  "title": "User prefers dark mode",
  "value": "The user explicitly asked for dark mode in all UI components. Use dark backgrounds (#1a1a2e) with light text (#e0e0e0).",
  "category": "preference"
}
```

### Categories

| Category | When to Use |
|----------|------------|
| `preference` | User likes, dislikes, style choices |
| `fact` | Verified information about user, project, or domain |
| `decision` | Architecture decisions, design choices with rationale |
| `context` | Background info that helps future conversations |
| `note` | General observations, reminders |
| `identity` | Agent's learned personality traits, communication style |

## Search

```json
{ "action": "search", "query": "database schema preferences" }
```

Returns ranked results with relevance scores. Supports semantic-style matching (expanded query terms).

### Scope Filtering

```json
{ "action": "search", "query": "API keys", "scope": "agent" }
```

| Scope | What It Searches |
|-------|-----------------|
| `auto` | Smart default: session + agent + global (recommended) |
| `session` | Current session only |
| `agent` | Current agent's memories |
| `project` | Current project's memories |
| `global` | Shared across all agents |
| `all` | Everything |

## Update

```json
{ "action": "update", "id": "mem_abc123", "value": "Updated: user now prefers system theme over dark mode" }
```

Use `update` when information changes. Avoids creating duplicate memories.

## When to Remember

**Do remember:**
- User-stated preferences ("I prefer TypeScript", "always use tabs")
- Corrections ("actually, the API endpoint is /v2/...")
- Project-specific facts (tech stack, coding conventions, team structure)
- Important decisions and their rationale

**Do not remember:**
- Ephemeral task details (file paths being edited right now)
- Information already in the codebase (README, config files)
- Trivial conversational context
- Sensitive data (passwords, tokens, private keys)

## When to Forget

Use `update` to revise outdated memories rather than storing contradictory ones. If a memory is no longer relevant, update its value to reflect the current state.

## Memory in Practice

1. **Start of session**: Relevant memories are automatically injected into context based on the current agent, project, and conversation topic.
2. **During conversation**: Store new insights as they emerge. Search when you need to recall something.
3. **End of significant interaction**: Store a summary of decisions made, preferences learned, or context that would help next time.

## Tips

- Write memories in the third person for clarity: "The user prefers..." not "You prefer..."
- Include enough context in the `value` that the memory is useful standalone
- Use descriptive `title` fields -- they're used for search ranking
- Prefer `category: "decision"` for architectural choices so they can be filtered later
