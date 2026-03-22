# Files Tool

Precise file operations on the real filesystem. Read, write, edit, list, and search files within the workspace.

## Actions

| Action | Description | Key Parameters |
|--------|-------------|----------------|
| `read` | Read file contents | `path` (required) |
| `write` | Create or overwrite a file | `path`, `content` (required) |
| `edit` | Structured string replacement | `path`, `old_string`, `new_string` (required) |
| `list` | List directory contents | `path` (optional, defaults to workspace root) |
| `search` | Search file contents with regex | `query` (required), `path` (optional) |

## Read

```json
{ "action": "read", "path": "src/index.ts" }
```

Reads the full file content. For large files, use `offset` and `limit` to read specific line ranges:

```json
{ "action": "read", "path": "src/index.ts", "offset": 50, "limit": 100 }
```

## Write

```json
{ "action": "write", "path": "src/config.ts", "content": "export const PORT = 3000\n" }
```

Creates the file if it doesn't exist. Creates parent directories automatically. Overwrites the entire file.

## Edit (Structured Replacement)

```json
{
  "action": "edit",
  "path": "src/index.ts",
  "old_string": "const port = 3000",
  "new_string": "const port = process.env.PORT || 3000"
}
```

**Rules:**
- `old_string` must match exactly one location in the file (including whitespace and indentation)
- If ambiguous, include more surrounding context to make it unique
- Preserves the rest of the file unchanged
- Preferred over `write` for modifying existing files (smaller diff, less error-prone)

## List

```json
{ "action": "list", "path": "src/components" }
```

Returns directory entries with file types. Use `depth` to control recursion:

```json
{ "action": "list", "path": "src", "depth": 2 }
```

## Search

```json
{ "action": "search", "query": "TODO|FIXME", "path": "src" }
```

Searches file contents using regex patterns. Returns matching lines with file paths and line numbers.

```json
{ "action": "search", "query": "export function", "path": "src/lib", "glob": "*.ts" }
```

## File Access Policy

- Workspace-scoped agents can only access files within the workspace directory
- Machine-scoped agents can access the broader filesystem (subject to blocked path rules)
- Paths like `/workspace/src/...` are automatically resolved to the workspace root
- Path traversal (`../`) outside allowed scope is blocked

## When to Use Files vs Execute

| Task | Tool |
|------|------|
| Read/write/edit specific files | **files** |
| Search across codebase | **files** (search action) |
| Complex text processing (awk, sed, jq) | **execute** |
| Running scripts or commands | **execute** |
| Batch file operations | **execute** |

## Tips

- Use `edit` for surgical changes to existing files. It's safer than `write` because it only changes the targeted string.
- Use `search` before `edit` to find the exact string to replace.
- Use `list` to explore directory structure before reading specific files.
- File paths are relative to the workspace root by default.
