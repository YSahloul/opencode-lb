/**
 * Context injection — lb state injected into sessions.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { AgentRegistry } from "./registry"

type Shell = PluginInput["$"]

export const LB_GUIDANCE = `<lb-guidance>
## lb CLI Usage

Use the bash tool to run lb commands. Do NOT call lb tools directly — they don't exist as MCP tools.

**Key commands:**
- \`lb sync\` — sync with Linear
- \`lb ready\` — show ready issues (todo_refined + todo_bug, unblocked)
- \`lb show <ID>\` — full issue details
- \`lb create "title" -d "desc"\` — create issue
- \`lb update <ID> --status <status>\` — update status
- \`lb close <ID> --reason "why"\` — close issue
- \`lb list --status <s> --json\` — filter/list issues

Use \`--json\` flag for structured output when parsing programmatically.

## Background Agent Orchestration

You have these tools for managing parallel background agents:

- **lb_dispatch** — Dispatch an issue to a background agent (creates worktree, launches opencode serve, sends prompt)
- **lb_check** — Check what a background agent is doing (reads its messages)
- **lb_followup** — Send follow-up instructions to a background agent
- **lb_abort** — Abort a background agent's current operation
- **lb_cleanup** — Kill tmux, delete worktree, update lb status
- **lb_agents** — List all running background agents

**Workflow:**
1. \`lb ready\` to find work
2. \`lb_dispatch\` with issue ID + prompt to spin up a background agent
3. \`lb_agents\` or \`lb_check\` to monitor progress
4. \`lb_followup\` if the agent needs course correction
5. \`lb_cleanup\` when done (sets status to in_review by default)

**Rules:**
- Always include the lb issue description in the dispatch prompt
- Include instructions to commit, push, create PR, and run \`lb update <ID> --status in_review\`
- The dispatch prompt should be self-contained — the background agent has no context from this session
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
