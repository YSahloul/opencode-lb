/**
 * Context injection — lb state injected into sessions.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { AgentRegistry } from "./registry"

type Shell = PluginInput["$"]

export const LB_GUIDANCE = `<lb-guidance>

## CRITICAL: Auto-Create Bug Issues

**When you discover ANY bug, issue, TODO, tech debt, or improvement opportunity while working — CREATE IT IN lb IMMEDIATELY. Do NOT mention it to the user and wait. Do NOT ask permission. Just create it.**

\`\`\`bash
lb create "Found: <description>" --discovered-from <CURRENT-ISSUE-ID> -d "Details about what you found, where, and why it matters"
\`\`\`

This creates a \`todo_bug\` issue that shows up in \`lb ready\` for any agent to pick up later. The \`--discovered-from\` flag links it to the issue you were working on when you found it.

**This is not optional. Every bug you notice, every edge case you skip, every hack you leave behind — create an issue for it. Silently. Immediately.**

## lb CLI Usage

Use the bash tool to run lb commands.

**Key commands:**
- \`lb sync\` — sync with Linear
- \`lb ready\` — show ready issues (todo_refined + todo_bug, unblocked)
- \`lb show <ID>\` — full issue details
- \`lb create "title" -d "desc"\` — create issue
- \`lb update <ID> --status <status>\` — update status
- \`lb close <ID> --reason "why"\` — close issue
- \`lb list --status <s> --json\` — filter/list issues

Use \`--json\` flag for structured output when parsing programmatically.

## Issue Refinement (CRITICAL STEP)

**An issue MUST be refined before it can be dispatched.** Unrefined issues produce bad work. The refinement step is what makes background agents effective.

**Pipeline:** \`todo_needs_refinement\` → (refine) → \`todo_refined\` → (dispatch) → \`in_progress\`

**To refine an issue:**
1. \`lb refine\` — list issues needing refinement
2. \`lb refine <ID>\` — see the issue + refinement checklist
3. Read the codebase to understand what needs to change
4. Update the issue description with:
   - **Context:** Why this matters, current vs desired behavior
   - **Technical Approach:** Which files/modules change, implementation strategy
   - **Acceptance Criteria:** Concrete testable conditions that define "done"
   - **Dependencies & Risks:** Blockers, unknowns, complexity estimate
   - **Subtasks** (if needed): \`lb create "Step: ..." --parent <ID>\`
5. \`lb update <ID> --status todo_refined\` — marks it ready for dispatch

**The description you write IS the prompt the background agent works from. If the refinement is vague, the agent will produce vague work. Be specific: name the files, describe the changes, define what "done" looks like.**

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
2. **Refine first** if the issue is \`todo_needs_refinement\` — run \`lb refine <ID>\` and follow the checklist
3. \`lb_dispatch\` with issue ID + prompt to spin up a background agent
4. \`lb_agents\` or \`lb_check\` to monitor progress
5. \`lb_followup\` if the agent needs course correction
6. \`lb_cleanup\` when done (sets status to in_review by default)

**Rules:**
- **NEVER dispatch an unrefined issue** — refine it first or the background agent will fail
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
