/**
 * Context injection — lb state injected into sessions.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { AgentRegistry } from "./registry"

type Shell = PluginInput["$"]

export const LB_GUIDANCE = `<lb-guidance>

## MANDATORY: All Work Flows Through lb

**NEVER do any work without an lb issue. No exceptions. No built-in todo tools. Only lb.**

### Status Pipeline

Every issue flows through these statuses in order:

\`\`\`
todo_needs_refinement → todo_refined → in_progress → in_review → done
                                ↗
                      todo_bug
\`\`\`

| Status | Meaning | How it gets here |
|--------|---------|-----------------|
| \`todo_needs_refinement\` | New idea, not ready to work on | \`lb create "title"\` |
| \`todo_refined\` | Has details, ready to pick up | \`lb update ID --status todo_refined\` |
| \`todo_bug\` | Bug found while working, ready to pick up | \`lb create "Found: ..." --discovered-from ID\` |
| \`in_progress\` | Actively being worked on | \`lb update ID --status in_progress\` |
| \`in_review\` | PR open, waiting for review | \`lb update ID --status in_review\` |
| \`done\` | Complete | \`lb close ID --reason "why"\` |

**\`lb ready\` only shows \`todo_refined\` and \`todo_bug\` issues.** Nothing else is visible. If you create an issue with \`lb create\`, it starts at \`todo_needs_refinement\` and is INVISIBLE to \`lb ready\` until you refine it.

### Session Start (MANDATORY)

Run these commands at the start of EVERY session:

\`\`\`bash
lb sync
lb ready
\`\`\`

### Creating and Refining Issues

**To create an issue:**
\`\`\`bash
lb create "title" -d "description"
\`\`\`
This creates it at \`todo_needs_refinement\`. It is NOT ready to work on yet.

**To make it workable, you MUST refine it:**
1. \`lb refine ID\` — see the issue + refinement checklist
2. Add implementation details: what files change, what the approach is, what "done" looks like
3. \`lb update ID --status todo_refined\` — NOW it shows up in \`lb ready\`

**If the user asks you to do work and no issue exists:**
1. \`lb create "title" -d "details"\` — create the issue
2. \`lb update ID --status todo_refined\` — refine it (add details if needed)
3. \`lb update ID --status in_progress\` — claim it
4. Do the work
5. \`lb update ID --status in_review\` — when PR is opened, or work is done pending review

**Shortcut for bugs found while working:**
\`\`\`bash
lb create "Found: <description>" --discovered-from <CURRENT-ISSUE-ID> -d "Details..."
\`\`\`
This goes straight to \`todo_bug\` and shows up in \`lb ready\` immediately.

### Doing Work

1. Pick an issue from \`lb ready\`
2. \`lb show ID\` — read the full description
3. \`lb update ID --status in_progress\` — claim it
4. Do the work (use worktrees for coding: \`lb worktree create ID-slug\`)
5. When done: \`lb update ID --status in_review\`
6. When merged: \`lb close ID --reason "what was done"\`

### Background Agent Orchestration

Tools for managing parallel background agents:

- **lb_dispatch** — Dispatch issue to background agent (creates worktree, launches opencode serve, sends prompt)
- **lb_check** — Check what a background agent is doing
- **lb_followup** — Send follow-up instructions to a running agent
- **lb_abort** — Abort agent's current operation
- **lb_cleanup** — Kill tmux, delete worktree, update lb status
- **lb_agents** — List all running background agents

**Dispatch workflow:**
1. Issue MUST be \`todo_refined\` before dispatch — \`lb ready\` to find work
2. \`lb_dispatch\` with issue ID + detailed prompt
3. \`lb_check\` or \`lb_agents\` to monitor
4. \`lb_followup\` if agent needs correction
5. \`lb_cleanup\` when done

### Rules

1. **NEVER work without an lb issue** — create one first, move it through the pipeline
2. **NEVER use built-in todo/task tools** — only lb
3. **NEVER dispatch an unrefined issue** — refine it first
4. **Always \`lb sync\` then \`lb ready\`** at session start
5. **Always \`lb show ID\`** before starting work
6. **Create bug issues immediately** when discovered — use \`--discovered-from\`
7. **Set \`in_review\` when opening a PR**, not \`done\`
8. **Always \`lb sync\`** before ending a session

### Key Commands

| Command | Purpose |
|---------|---------|
| \`lb sync\` | Sync with Linear |
| \`lb ready\` | Show workable issues (todo_refined + todo_bug) |
| \`lb refine\` | List issues needing refinement |
| \`lb refine ID\` | Show issue + refinement checklist |
| \`lb show ID\` | Full issue details |
| \`lb create "Title" -d "..."\` | Create issue (starts at todo_needs_refinement) |
| \`lb update ID --status <status>\` | Move issue through pipeline |
| \`lb close ID --reason "why"\` | Mark done |
| \`lb list --status <s> --json\` | Filter/list issues |

</lb-guidance>`

/**
 * Build lb context string with ready issues and running agents.
 */
export async function getLbContext(
  $: Shell,
  registry: AgentRegistry,
): Promise<string | null> {
  try {
    let context = "<lb-context>\n"

    // Ready issues
    try {
      const ready = (await $`lb ready --json`.quiet().text()).trim()
      if (ready && ready !== "[]") {
        context += `## Ready Issues\n${ready}\n\n`
      } else {
        context += "## Ready Issues\nNone\n\n"
      }
    } catch {
      context += "## Ready Issues\n(lb ready failed)\n\n"
    }

    // In-progress issues
    try {
      const inProgress = (
        await $`lb list --status in_progress --json`.quiet().text()
      ).trim()
      if (inProgress && inProgress !== "[]") {
        context += `## In Progress\n${inProgress}\n\n`
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

    context += "</lb-context>"
    return context
  } catch {
    return null
  }
}
