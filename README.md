# opencode-lb

OpenCode plugin for [linear-beads](https://github.com/nikvdp/linear-beads) (`lb`) orchestration. Manages parallel background agents in isolated git worktrees, each running as a headless `opencode serve` instance in tmux.

## What it does

The plugin turns the orchestrator agent into a coordinator that can spin up, monitor, and tear down background coding agents — each working on a separate Linear issue in its own worktree. Instead of the agent manually running 15+ bash commands to launch a background worker, it calls a single `lb_dispatch` tool.

**Dispatch pipeline (one tool call):**

```
lb_dispatch("AGE-42", prompt)
    -> lb update AGE-42 --status in_progress
    -> lb worktree create AGE-42-fix-auth
    -> tmux new-session (opencode serve)
    -> wait for port
    -> POST /session (create)
    -> POST /session/:id/prompt_async (send task)
    -> lb update AGE-42 -d "Port: 62109, tmux: AGE_42, session: ..."
    -> return { port, sessionId, tmux, branch }
```

## Installation

### Prerequisites

- [OpenCode](https://opencode.ai) CLI
- [linear-beads](https://github.com/nikvdp/linear-beads) (`lb`) installed and configured
- [tmux](https://github.com/tmux/tmux)
- `lb init` run in your project

### Local (development)

Clone the repo and reference it as a `file://` plugin:

```bash
git clone https://github.com/YSahloul/opencode-lb.git ~/.config/opencode/plugin/opencode-lb
```

Add to your `opencode.json`:

```jsonc
{
  "plugin": [
    "file:///path/to/.config/opencode/plugin/opencode-lb/index.ts"
  ]
}
```

Restart OpenCode. The plugin loads on startup — no build step needed.

## Tools

The plugin registers 6 tools the LLM can call directly:

| Tool | Description |
|------|-------------|
| `lb_dispatch` | Dispatch an issue to a background worktree agent. Creates worktree, launches `opencode serve` in tmux, creates session, sends prompt. Returns port, sessionId, tmux session name, and branch. |
| `lb_check` | Check on a background agent. Fetches recent messages from the `opencode serve` API. Falls back to `tmux capture-pane` if the API is unreachable. |
| `lb_followup` | Send follow-up instructions to a running background agent. |
| `lb_abort` | Abort a background agent's current operation. Server stays running for new messages. |
| `lb_cleanup` | Kill tmux session, delete worktree, update lb status (default: `in_review`), sync. |
| `lb_agents` | List all running background agents with reachability status, port, session, and branch. |

### `lb_dispatch`

```
Args:
  issueId  (string, required)  — Linear issue ID (e.g. "AGE-42")
  prompt   (string, required)  — Task prompt for the background agent
  model    (string, optional)  — Model ID (default: "claude-sonnet-4-6")
  provider (string, optional)  — Provider ID (default: "anthropic")
  slug     (string, optional)  — Branch name suffix (default: issue ID only)
```

### `lb_check`

```
Args:
  issueId  (string, required)  — Linear issue ID
  lines    (number, optional)  — Number of recent messages to fetch (default: 10)
```

### `lb_followup`

```
Args:
  issueId  (string, required)  — Linear issue ID
  message  (string, required)  — Follow-up instructions to send
```

### `lb_abort`

```
Args:
  issueId  (string, required)  — Linear issue ID
```

### `lb_cleanup`

```
Args:
  issueId  (string, required)  — Linear issue ID
  status   (enum, optional)    — "in_review" | "todo_refined" | "done" (default: "in_review")
  force    (boolean, optional) — Force delete worktree without safety checks
```

### `lb_agents`

```
Args: none
```

## Hooks

| Hook | Trigger | Behavior |
|------|---------|----------|
| `chat.message` | First message in a session | Injects `<lb-context>` (ready issues, in-progress, running agents) and `<lb-guidance>` (CLI usage + orchestration instructions) |
| `event(session.compacted)` | Context window compacted | Re-injects lb context so the agent doesn't lose track of issues and agents |
| `event(session.idle)` | Agent finishes a turn | Polls all tracked background agents. Toasts on completion. Auto-syncs lb. |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/lb:ready` | Show ready issues |
| `/lb:status` | Show all running background agents |
| `/lb:dispatch <ID>` | Dispatch an issue to a background agent |
| `/lb:check <ID>` | Check on a background agent |
| `/lb:cleanup <ID>` | Clean up a background agent |
| `/lb:sync` | Sync lb with Linear |
| `/lb:show <ID>` | Show issue details |

## Subagent

The plugin registers an `lb-task-agent` subagent that autonomously finds and completes ready issues. It handles the full cycle: claim, implement, commit, push, PR, status update.

## Architecture

```
opencode (orchestrator)
  |
  |— opencode-lb plugin
  |    |— registry (in-memory Map<issueId, AgentEntry>)
  |    |— tools (lb_dispatch, lb_check, lb_followup, lb_abort, lb_cleanup, lb_agents)
  |    |— hooks (context injection, compaction recovery, idle polling)
  |    |— commands (/lb:ready, /lb:dispatch, etc.)
  |    |— subagent (lb-task-agent)
  |
  |— background agents (one per dispatched issue)
       |— tmux session (AGE_42)
       |— git worktree (/path/to/AGE-42-fix-auth)
       |— opencode serve (http://localhost:62109)
            |— session (ses_abc123)
            |— prompt (task from orchestrator)
```

### Registry reconstruction

On startup, the plugin reads `lb list --status in_progress --json`, parses `Port: X, tmux: Y, session: Z` metadata from issue descriptions, verifies tmux sessions are alive, and rebuilds the in-memory registry. This means if OpenCode restarts, it picks up running background agents automatically.

### Port tracking

Each background agent's port, tmux session name, and session ID are recorded on the lb issue description (`lb update AGE-XX -d "Port: ..., tmux: ..., session: ..."`). This is the source of truth for reconstruction and also visible in Linear.

## File structure

```
opencode-lb/
  index.ts          — Plugin entry point. Tools, hooks, config registration.
  orchestrator.ts   — dispatch, check, followup, abort, cleanup, reconstruct logic.
  registry.ts       — In-memory agent state (Map<issueId, AgentEntry>).
  context.ts        — lb context injection (ready issues, running agents, guidance).
  commands.ts       — /lb:* slash commands and lb-task-agent subagent config.
```

## License

MIT
