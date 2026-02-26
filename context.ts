/**
 * Context injection — the single source of truth for lb agent instructions.
 *
 * This replaces AGENTS.md as the authoritative lb reference. The plugin injects
 * this on every session start and after every compaction, so agents always have
 * current instructions + live state. No static files to drift out of sync.
 *
 * Design inspired by beads' `bd prime` — one dynamic injection point that
 * adapts to current state, replaces scattered static docs.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { AgentRegistry } from "./registry"

type Shell = PluginInput["$"]

// ─── Static guidance: everything an agent needs to know about lb ──────────

export const LB_GUIDANCE = `<lb-guidance>

## CRITICAL: All Work Flows Through lb

> **DO NOT use built-in todo/task tracking tools. EVER.**
> No todo lists, no task trackers, no scratchpads — ONLY \`lb\`.
> \`lb\` IS your todo list. There is no other.

### Session Start (MANDATORY)

\`\`\`bash
lb sync        # Pull latest issues from Linear
lb ready       # See what's available to work on
\`\`\`

### Issue Pipeline

\`\`\`
todo_needs_refinement → todo_refined → in_progress → in_review → done
                                ↗
                      todo_bug
\`\`\`

| Status | Meaning |
|--------|---------|
| \`todo_needs_refinement\` | New idea — needs details before anyone can work on it |
| \`todo_refined\` | Has details, ready to pick up (shown by \`lb ready\`) |
| \`todo_bug\` | Bug found while working (shown by \`lb ready\`) |
| \`in_progress\` | Actively being worked on |
| \`in_review\` | PR open, waiting for review |
| \`done\` | Complete |

**\`lb ready\` ONLY shows \`todo_refined\` and \`todo_bug\`.** If you \`lb create\` an issue, it starts at \`todo_needs_refinement\` and is INVISIBLE until refined.

### Two Paths Into the Pipeline

**Path 1 — New work:**
1. \`lb create "title" -d "details"\` → starts at \`todo_needs_refinement\`
2. \`lb refine ID\` → see refinement checklist
3. Add implementation details, acceptance criteria
4. \`lb update ID --status todo_refined\` → now visible in \`lb ready\`

**Path 2 — Bug found while working:**
\`\`\`bash
lb create "Found: <description>" --discovered-from <CURRENT-ISSUE-ID> -d "Details..."
\`\`\`
Goes straight to \`todo_bug\` → visible in \`lb ready\` immediately.

**Create bugs IMMEDIATELY when you discover them. Do not wait. Do not ask permission.**

### CRITICAL: All Coding Happens in Worktrees — NEVER on Main

> **You MUST NEVER write code, edit files, or make commits directly on the main/master branch.**
> **Every issue gets its own worktree with its own branch. No exceptions.**
>
> The main session is a **coordinator** — it claims issues and creates worktrees.
> Worktree sessions do the actual implementation.

### Coding Workflow (Coordinator — Main Session)

1. \`lb ready\` → pick an issue
2. \`lb show ID\` → read the full description
3. \`lb update ID --status in_progress\` → claim it
4. **Create a worktree** — this is MANDATORY before any coding:
   \`\`\`bash
   lb worktree create ID-short-description
   \`\`\`
   This automatically: creates a git worktree as a sibling directory, creates a new branch, copies .env files, installs dependencies or symlinks node_modules, symlinks .opencode/ and .claude/, runs \`lb init\` + \`lb sync\`.
5. A new agent session opens in the worktree — it handles the implementation
6. The worktree agent opens a PR, then: \`lb update ID --status in_review\`
7. Clean up when finished:
   \`\`\`bash
   lb worktree delete ID-short-description
   \`\`\`
8. Human merges → \`lb update ID --status done\`

**If you are the main session and you catch yourself editing code: STOP. Create a worktree first.**

### Worktree Sessions (When You ARE in a Worktree)

If your branch name starts with an issue ID (e.g. \`AGE-99-fix-auth\`), you are a **worktree agent**.
Your job is to implement that specific issue. Follow these steps:

1. \`lb sync\` — pull all issues from Linear
2. Extract the issue ID from your branch name (e.g. \`AGE-99\` from \`AGE-99-fix-auth\`)
3. \`lb show ID\` → read the full issue description
4. \`lb update ID --status in_progress\` → claim it
5. **Implement the work.** You are in a worktree — code freely here.
6. Commit, push, open a PR to main
7. \`lb update ID --status in_review\`
8. \`lb sync\`

### Worktree Management

\`\`\`bash
# Create a worktree (MANDATORY before any coding)
lb worktree create AGE-42-fix-auth

# Create from a specific base branch
lb worktree create AGE-42-fix-auth --base develop

# List active worktrees
lb worktree list

# Remove a worktree (checks for uncommitted/unpushed work)
lb worktree delete AGE-42-fix-auth

# Force remove (skip safety checks)
lb worktree delete AGE-42-fix-auth --force
\`\`\`

### Planning (SUBISSUES, NOT BUILT-IN TODOS)

Break down tasks as lb subissues:

\`\`\`bash
lb create "Step 1: Do X" --parent LIN-XXX -d "Details..."
lb create "Step 2: Do Y" --parent LIN-XXX -d "Details..."
lb create "Step 3: Do Z" --parent LIN-XXX --blocked-by LIN-YYY
\`\`\`

### Dependencies

\`\`\`bash
lb create "Must do first" --blocks LIN-123
lb create "Depends on auth" --blocked-by LIN-100
lb dep add LIN-A --blocks LIN-B
lb dep tree LIN-A
\`\`\`

### Background Agent Orchestration

Tools for parallel background agents:

| Tool | Purpose |
|------|---------|
| \`lb_dispatch\` | Dispatch issue to background agent (creates worktree, launches server, sends prompt) |
| \`lb_check\` | Check what a background agent is doing |
| \`lb_followup\` | Send follow-up instructions to a running agent |
| \`lb_abort\` | Abort agent's current operation |
| \`lb_cleanup\` | Kill tmux, delete worktree, update status |
| \`lb_agents\` | List all running background agents |

**Dispatch workflow:**
1. Issue MUST be \`todo_refined\` first — \`lb ready\` to find work
2. \`lb_dispatch\` with issue ID + detailed prompt
3. \`lb_check\` or \`lb_agents\` to monitor
4. \`lb_cleanup\` when done (defaults to \`in_review\`)

### Key Commands

| Command | Purpose |
|---------|---------|
| \`lb sync\` | Sync with Linear |
| \`lb ready\` | Show unblocked ready issues |
| \`lb refine\` | List issues needing refinement |
| \`lb refine ID\` | Show issue + refinement checklist |
| \`lb blocked\` | Show blocked issues |
| \`lb show ID\` | Full issue details |
| \`lb create "Title" -d "..."\` | Create issue |
| \`lb create "Title" --parent ID\` | Create subtask |
| \`lb create "Title" --discovered-from ID\` | Create bug (goes to \`todo_bug\`) |
| \`lb update ID --status <s>\` | Update status |
| \`lb update ID --status done\` | Mark complete |
| \`lb update ID --label name\` | Add label |
| \`lb dep add ID --blocks OTHER\` | Add dependency |
| \`lb dep tree ID\` | Show dependency tree |
| \`lb worktree create BRANCH\` | **MANDATORY before coding** — create worktree + branch |
| \`lb worktree delete BRANCH\` | Remove worktree (after PR merged) |
| \`lb worktree list\` | Show active worktrees |
| \`lb list --status <s>\` | Filter issues |

### Rules

1. **NEVER code on main/master** — always create a worktree with \`lb worktree create\` first. The main session is a coordinator, not an implementer.
2. **NEVER use built-in todo tools** — only \`lb\`. No exceptions.
3. **Always \`lb sync\` then \`lb ready\`** at session start.
4. **Always \`lb show ID\`** before starting work.
5. **Always \`lb worktree create\`** before writing any code — every issue gets its own branch in a parallel worktree.
6. **Create bug issues immediately** — use \`--discovered-from\`.
7. **Set \`in_review\` when opening a PR.**
8. **Set \`done\` when work is complete** — PR merged, issue fully resolved. Run \`lb update ID --status done\`.
9. **Always \`lb sync\`** before ending a session.
10. **Memory is ephemeral.** Offload everything to \`lb\` tickets — decisions, context, blockers, checkpoints. \`lb\` is your persistent brain.

</lb-guidance>`

// ─── Dynamic context: live state injected alongside guidance ──────────────

/**
 * Build dynamic lb context — ready issues, in-progress work, running agents.
 * Includes warnings when the agent appears to not be following the pipeline.
 */
export async function getLbContext(
  $: Shell,
  registry: AgentRegistry,
): Promise<string | null> {
  try {
    let context = "<lb-context>\n"

    // Helper: run lb with a timeout to prevent zombie processes
    const lbWithTimeout = async (args: string[], timeoutMs = 15000): Promise<string> => {
      const proc = Bun.spawn(["lb", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, LB_TIMEOUT_MS: String(timeoutMs) },
      })
      const result = await Promise.race([
        proc.exited.then(async () => {
          return new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer())
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            proc.kill()
            reject(new Error("lb subprocess timed out"))
          }, timeoutMs)
        }),
      ])
      return result.trim()
    }

    // Ready issues
    let readyCount = 0
    try {
      const ready = await lbWithTimeout(["ready", "--json"])
      if (ready && ready !== "[]") {
        const parsed = JSON.parse(ready)
        readyCount = Array.isArray(parsed) ? parsed.length : 0
        context += `## Ready Issues (${readyCount})\n${ready}\n\n`
      } else {
        context += "## Ready Issues\nNone\n\n"
      }
    } catch {
      context += "## Ready Issues\n(lb ready failed — run lb sync)\n\n"
    }

    // In-progress issues
    let inProgressCount = 0
    try {
      const inProgress = await lbWithTimeout(["list", "--status", "in_progress", "--json", "--no-sync"])
      if (inProgress && inProgress !== "[]") {
        const parsed = JSON.parse(inProgress)
        inProgressCount = Array.isArray(parsed) ? parsed.length : 0
        context += `## In Progress (${inProgressCount})\n${inProgress}\n\n`
      }
    } catch {}

    // Running background agents
    if (registry.size() > 0) {
      context += "## Running Background Agents\n"
      for (const [issueId, agent] of registry.entries()) {
        context += `- ${issueId}: port=${agent.port}, tmux=${agent.tmuxSession}, branch=${agent.branch}\n`
      }
      context += "\n"
    }

    // Warnings — nudge agents that aren't following the pipeline
    if (inProgressCount === 0 && readyCount > 0) {
      context += `## ⚠ WARNING\nYou have ${readyCount} ready issue(s) but nothing in progress. Run \`lb ready\`, pick one, and \`lb update ID --status in_progress\` before doing any work.\n\n`
    } else if (inProgressCount === 0 && readyCount === 0) {
      context += `## Note\nNo ready issues and nothing in progress. Run \`lb sync\` to refresh, or create new work with \`lb create\`.\n\n`
    }

    context += "</lb-context>"
    return context
  } catch {
    return null
  }
}
