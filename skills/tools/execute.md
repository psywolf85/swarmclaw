# Execute Tool

Run bash scripts in a sandboxed or host environment with credential injection.

## Usage

```json
{ "code": "curl -s https://api.example.com/data | jq '.results[]'" }
```

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | Yes | The bash script to execute |
| `persistent` | boolean | No | Use host backend for real filesystem writes (default: false) |
| `timeout` | number | No | Timeout in seconds (default: 30, max: 300) |

## Backends

### Sandbox (default)
- Powered by [just-bash](https://github.com/vercel-labs/just-bash)
- **Reads** workspace files from disk via OverlayFS
- **Writes** stay in memory (ephemeral)
- 70+ built-in commands: ls, cat, grep, sed, awk, jq, yq, curl, git, find, sort, etc.
- Execution limits: 1000 commands, 10000 loop iterations, 50 call depth
- No npm, no Node.js — use host mode for that

### Host (opt-in)
- Real bash on the host system
- Full filesystem access (respects file access policy)
- npm, git, background processes, persistent writes
- Inherits system PATH and environment

## Environment Variables

Credentials configured for the agent are injected as environment variables:

| Variable | Source |
|----------|--------|
| `$WORKSPACE` | Workspace root directory |
| `$<PROVIDER>_API_KEY` | Auto-named from credential provider |

Secrets are **automatically redacted** from output.

## Examples

### Data processing
```bash
cat data.csv | awk -F',' '{print $2, $3}' | sort -n | head -20
```

### API call with credential injection
```bash
curl -s -H "Authorization: Bearer $OPENAI_API_KEY" \
  https://api.openai.com/v1/models | jq '.data[].id'
```

### JSON transformation
```bash
curl -s https://api.github.com/repos/vercel/next.js/releases/latest \
  | jq '{tag: .tag_name, date: .published_at, assets: [.assets[].name]}'
```

### File inspection (sandbox reads workspace via OverlayFS)
```bash
find /workspace/src -name "*.ts" | wc -l
grep -r "TODO" /workspace/src --include="*.ts" -l
```

### Persistent write (host mode required)
```json
{ "code": "echo 'hello' > output.txt", "persistent": true }
```

## Limitations (Sandbox Mode)

- No npm/Node.js (use host mode for package management)
- No background processes
- Writes are ephemeral (use `files` tool for persistent changes)
- ~60 unimplemented bash features (PIPESTATUS, some `set -e` edge cases)
- 64MB memory limit for JavaScript/Python runtimes
- Use the `files` tool for precise code editing (sed/awk can be unreliable for multi-line edits)

## When to Use Host Mode

- Installing packages (`npm install`, `pip install`)
- Running test suites (`npm test`, `pytest`)
- Git operations that need persistence (`git commit`, `git push`)
- Long-running processes
- Using npm ecosystem libraries

## Optional Runtimes (Sandbox Only)

When enabled in agent config:
- **Python**: `python3 -c 'print("hello")'`
- **JavaScript**: `js-exec 'console.log("hello")'`
- **SQLite**: `sqlite3 :memory: 'SELECT 1+1'`
