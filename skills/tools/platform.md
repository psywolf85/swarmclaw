# Platform Tool

Interact with the SwarmClaw platform: manage tasks, communicate with humans and other agents, access projects, and participate in chatrooms.

## Action Groups

### Tasks

| Action | Description | Key Parameters |
|--------|-------------|----------------|
| `tasks.create` | Create a new task | `title`, `description`, `priority` |
| `tasks.update` | Update task fields | `id`, fields to update |
| `tasks.list` | List tasks with filters | `status`, `assignee`, `priority` |
| `tasks.get` | Get task details | `id` |
| `tasks.complete` | Mark task as done | `id`, `result` (optional summary) |

#### Create a task

```json
{
  "action": "tasks.create",
  "title": "Review PR #55",
  "description": "Check for type safety issues and test coverage",
  "priority": "high"
}
```

#### List open tasks

```json
{ "action": "tasks.list", "status": "open" }
```

### Communication

| Action | Description | Key Parameters |
|--------|-------------|----------------|
| `communicate.ask_human` | Block and wait for human input | `question`, `context` |
| `communicate.send_message` | Send to a connector channel | `connector`, `channel`, `message` |
| `communicate.delegate` | Route work to another agent | `agentId`, `message` |
| `communicate.spawn` | Create a subagent for parallel work | `agentId`, `message`, `mode` |

#### Ask human (blocks execution)

```json
{
  "action": "communicate.ask_human",
  "question": "Should I proceed with the database migration?",
  "context": "This will add 3 new columns to the users table and backfill existing rows."
}
```

**Important:** `ask_human` blocks the agent loop until the human responds. Use it when you genuinely need input before continuing. Do not use it for status updates (use `send_message` instead).

#### Send a message to Discord/Slack/Telegram

```json
{
  "action": "communicate.send_message",
  "connector": "discord",
  "channel": "#general",
  "message": "Deployment complete. All tests passing."
}
```

#### Delegate to another agent

```json
{
  "action": "communicate.delegate",
  "agentId": "agent_research",
  "message": "Find the top 5 competitors in the AI coding assistant space and summarize their pricing."
}
```

#### Spawn a subagent

```json
{
  "action": "communicate.spawn",
  "agentId": "agent_coder",
  "message": "Implement the dark mode toggle component",
  "mode": "run"
}
```

Modes:
- `run` -- fire and forget, subagent runs independently
- `session` -- creates a persistent session you can check on later

### Projects

| Action | Description | Key Parameters |
|--------|-------------|----------------|
| `projects.list` | List all projects | (none) |
| `projects.get` | Get project details | `id` |

```json
{ "action": "projects.list" }
```

### Chatrooms

| Action | Description | Key Parameters |
|--------|-------------|----------------|
| `chatrooms.send` | Send a message to a chatroom | `chatroomId`, `message` |
| `chatrooms.list` | List available chatrooms | (none) |
| `chatrooms.history` | Get recent messages | `chatroomId`, `limit` |

```json
{
  "action": "chatrooms.send",
  "chatroomId": "room_design",
  "message": "The mockups are ready for review."
}
```

### Agents

| Action | Description | Key Parameters |
|--------|-------------|----------------|
| `agents.list` | List all agents | (none) |
| `agents.get` | Get agent details | `id` |

```json
{ "action": "agents.list" }
```

## Communication Decision Guide

| Situation | Action |
|-----------|--------|
| Need human approval before proceeding | `communicate.ask_human` |
| Sharing a status update with the team | `communicate.send_message` |
| Task is outside your expertise | `communicate.delegate` |
| Task can run in parallel with your work | `communicate.spawn` |
| Collaborating with agents in a shared space | `chatrooms.send` |

## Tips

- Use `ask_human` sparingly. Only block when you truly cannot proceed without input.
- When delegating, provide enough context that the target agent can work independently.
- Check `tasks.list` before creating duplicates.
- Use `agents.list` to discover available agents and their capabilities before delegating.
