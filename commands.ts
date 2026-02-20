/**
 * Slash commands and subagent definitions registered via config hook.
 */

export const COMMANDS: Record<string, { template: string; description?: string }> = {
  "lb:ready": {
    description: "Show ready lb issues",
    template: "Run `lb ready` and show me what's available to work on.",
  },
  "lb:status": {
    description: "Show all running background agents",
    template:
      "Use the lb_agents tool to list all running background agents. Show their status, port, branch, and whether they're reachable.",
  },
  "lb:dispatch": {
    description: "Dispatch issue to background agent (issue ID)",
    template:
      'Run `lb show $ARGUMENTS` to get the issue details, then use lb_dispatch to spin up a background agent for it. Include the full issue description and instructions to commit, push, create a PR, and run `lb update $ARGUMENTS --status in_review` when done.',
  },
  "lb:check": {
    description: "Check on a background agent (issue ID)",
    template:
      "Use lb_check with issue ID $ARGUMENTS to see what the background agent is doing. Summarize its recent activity.",
  },
  "lb:cleanup": {
    description: "Clean up a background agent (issue ID)",
    template:
      "Use lb_cleanup with issue ID $ARGUMENTS to kill the tmux session, delete the worktree, and update the lb status.",
  },
  "lb:sync": {
    description: "Sync lb with Linear",
    template: "Run `lb sync` and report results.",
  },
  "lb:show": {
    description: "Show issue details (issue ID)",
    template: "Run `lb show $ARGUMENTS` and summarize the issue.",
  },
}

export const AGENT_CONFIG: Record<string, { description?: string; prompt: string; mode: string }> = {
  "lb-task-agent": {
    description:
      "Autonomous agent that finds and completes ready lb issues. Handles the full cycle: claim, implement, commit, push, PR, status update.",
    prompt: `You are an lb task agent. Your job is to autonomously complete issues from lb (linear-beads).

## Workflow

1. Run \`lb ready --json\` to find unblocked work
2. Pick the highest priority issue
3. Run \`lb show <ID>\` to get full details
4. Run \`lb update <ID> --status in_progress\` to claim it
5. Implement the work described in the issue
6. Commit, push, and create a PR with \`gh pr create\`
7. Run \`lb update <ID> --status in_review\`
8. Check \`lb ready\` for more work

## Rules

- Always read the full issue description before starting
- Create sub-issues for discovered bugs: \`lb create "Found: ..." --discovered-from <ID>\`
- Include clear commit messages and PR descriptions
- Run tests if they exist
- Set in_review when PR is opened, not done
- Always \`lb sync\` when finished`,
    mode: "subagent",
  },
}
