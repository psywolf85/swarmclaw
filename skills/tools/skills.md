# Skills Tool

Discover and load skill files that teach you how to use tools, APIs, and workflows.

## Actions

| Action | Description | Key Parameters |
|--------|-------------|----------------|
| `list` | Browse all available skills | (none) |
| `read` | Load a skill by name | `name` |
| `search` | Find skills by keyword | `query` |

## List Available Skills

```json
{ "action": "list" }
```

Returns all discoverable skill files with names and short descriptions.

## Read a Skill

```json
{ "action": "read", "name": "tools/files" }
```

Loads the full content of a skill file. Skill names use path-style notation:

- `tools/files` -- the files tool documentation
- `tools/memory` -- the memory tool documentation
- `swarmclaw` -- the platform overview skill
- `github` -- GitHub CLI operations

Name matching is flexible: partial matches work if unambiguous.

## Search Skills

```json
{ "action": "search", "query": "browser screenshot" }
```

Searches skill file names, descriptions, and content for keyword matches. Returns ranked results.

## Skill File Locations

| Directory | Source | Description |
|-----------|--------|-------------|
| `skills/` | Built-in | Shipped with SwarmClaw, checked into the repo |
| `data/skills/` | User-created | Added at runtime, not version-controlled |

## Skill File Format

Skills are markdown files (`.md`). They can be:

- **Flat files**: `skills/swarmclaw.md`
- **Directory-based**: `skills/github/SKILL.md`
- **Nested**: `skills/tools/files.md`

Optional YAML frontmatter can declare metadata:

```yaml
---
name: my-skill
description: What this skill teaches
metadata:
  openclaw:
    requires:
      bins: ["gh"]
---
```

## When to Use Skills

- **Before using an unfamiliar tool**: Load its skill to understand parameters, patterns, and best practices.
- **When stuck on a task**: Search for skills related to what you're trying to accomplish.
- **At the start of a session**: List skills to understand what documentation is available.

## Tips

- Skills are read-only reference material. They don't execute anything.
- Load the relevant tool skill before attempting complex operations with that tool.
- If a skill doesn't exist for what you need, you can still use the tool directly -- skills are guides, not gates.
- User-created skills in `data/skills/` take the same format as built-in ones.
