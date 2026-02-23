/**
 * Orchestration logic — dispatch, check, followup, abort, cleanup, reconstruct.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { AgentRegistry } from "./registry"
import type { LifecycleEmitter } from "./lifecycle"

type Shell = PluginInput["$"]

/**
 * Fetch the issue description from lb show --json.
 */
async function getIssueDescription($: Shell, issueId: string): Promise<string> {
  try {
    const json = await $`lb show ${issueId} --json`.quiet().text()
    const issue = JSON.parse(json.trim())
    return issue.description || issue.title || ""
  } catch {
    // Fallback to non-json
    try {
      return (await $`lb show ${issueId}`.quiet().text()).trim()
    } catch {
      return ""
    }
  }
}

/**
 * Get git diff stat for a worktree to show additions/deletions.
 */
async function getGitDiffStat($: Shell, worktreePath: string): Promise<string | null> {
  try {
    const stat = (
      await $`git -C ${worktreePath} diff --stat HEAD`.quiet().nothrow().text()
    ).trim()
    return stat || null
  } catch {
    return null
  }
}

/**
 * Determine the actual session status from the opencode serve API.
 * Returns: "running" | "idle" | "finished" | "unreachable"
 */
async function getSessionStatus(port: number, sessionId: string): Promise<string> {
  try {
    // Check session messages to see if there's active generation
    const resp = await fetch(
      `http://localhost:${port}/session/${sessionId}/message`,
    )
    if (!resp.ok) return "unreachable"

    const messages = (await resp.json()) as any[]
    if (messages.length === 0) return "idle"

    // Check the last message — if it's from the assistant and complete, the agent is idle
    const lastMsg = messages[messages.length - 1]
    const role = lastMsg?.info?.role || lastMsg?.role
    const status = lastMsg?.info?.status || lastMsg?.status

    if (role === "assistant" && (status === "completed" || status === "done")) {
      return "finished"
    }
    if (role === "assistant" && status === "streaming") {
      return "running"
    }
    // If last message is from user, agent is processing
    if (role === "user") {
      return "running"
    }

    return "idle"
  } catch {
    return "unreachable"
  }
}

/**
 * Dispatch an issue to a background worktree agent.
 * Creates worktree, launches opencode serve in tmux, sends the prompt.
 * Auto-injects the issue description into the prompt.
 */
export async function dispatch(
  $: Shell,
  registry: AgentRegistry,
  emitter: LifecycleEmitter,
  args: {
    issueId: string
    prompt: string
    model?: string
    provider?: string
    slug?: string
    skipWorktree?: boolean
  },
): Promise<string> {
  const { issueId, prompt, model, provider, slug, skipWorktree } = args
  const modelId = model || "claude-sonnet-4-6"
  const providerId = provider || "anthropic"

  // Derive branch name
  const branch = slug
    ? `${issueId}-${slug}`
    : `${issueId}`

  // tmux session name: underscores not hyphens (hyphens + numbers confuse tmux)
  const tmuxSession = issueId.replace(/-/g, "_")

  // Check if already dispatched
  if (registry.has(issueId)) {
    const existing = registry.get(issueId)!
    return JSON.stringify({
      status: "already_dispatched",
      ...existing,
    })
  }

  try {
    // 0. Auto-inject issue description into prompt
    const issueDesc = await getIssueDescription($, issueId)
    const fullPrompt = issueDesc
      ? `## Issue: ${issueId}\n\n${issueDesc}\n\n---\n\n${prompt}`
      : prompt

    // 1. Claim the issue
    await $`lb update ${issueId} --status in_progress`.quiet()
    await emitter.emit("agent:claimed", { issueId, branch })

    let wtPath: string

    if (skipWorktree) {
      // Use repo root directly (read-only tasks)
      wtPath = (await $`git rev-parse --show-toplevel`.quiet().text()).trim()
    } else {
      // 2. Create worktree
      await $`lb worktree create ${branch}`.quiet()

      // 3. Resolve worktree path (sibling of current repo root)
      const repoRoot = (await $`git rev-parse --show-toplevel`.quiet().text()).trim()
      const parentDir = (await $`dirname ${repoRoot}`.quiet().text()).trim()
      wtPath = `${parentDir}/${branch}`
    }

    // 4. Launch opencode serve in tmux
    const logFile = `/tmp/opencode-${issueId}.log`
    await $`rm -f ${logFile}`.quiet()
    // Wrap in bash -c so pipes/redirects work correctly inside tmux
    // and quiet() to prevent any output bleeding into the current terminal
    await $`tmux new-session -d -s ${tmuxSession} -c ${wtPath} bash -c ${"opencode serve 2>&1 | tee " + logFile}`.quiet()

    // 5. Wait for server to start and capture port
    const port = await waitForPort($, logFile)

    // 6. Create session
    const sessionResp = await fetch(`http://localhost:${port}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: issueId }),
    })
    const sessionData = (await sessionResp.json()) as { id: string }
    const sessionId = sessionData.id

    // 7. Send the task prompt (with auto-injected issue description)
    await fetch(`http://localhost:${port}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: fullPrompt }],
        model: { providerID: providerId, modelID: modelId },
      }),
    })

    // 8. Record metadata on the lb issue
    const meta = `Port: ${port}, tmux: ${tmuxSession}, session: ${sessionId}`
    await $`lb update ${issueId} -d ${meta}`.quiet()

    // 9. Register in memory
    const entry = {
      issueId,
      port,
      sessionId,
      tmuxSession,
      branch: skipWorktree ? "(no worktree)" : branch,
      worktreePath: wtPath,
      dispatchedAt: new Date().toISOString(),
    }
    registry.set(issueId, entry)

    // 10. Emit running event — serve is up and session created
    await emitter.emit("agent:running", { issueId, branch, port })

    return JSON.stringify({ status: "dispatched", ...entry })
  } catch (e: any) {
    return JSON.stringify({
      status: "error",
      issueId,
      error: e?.message || String(e),
    })
  }
}

/**
 * Wait for opencode serve to print its port, with timeout.
 */
async function waitForPort($: Shell, logFile: string, timeoutMs = 30000): Promise<number> {
  const start = Date.now()
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  while (Date.now() - start < timeoutMs) {
    try {
      const log = await $`cat ${logFile}`.quiet().nothrow().text()
      // Match "listening on http://127.0.0.1:XXXXX" or "listening on http://localhost:XXXXX"
      const match = log.match(/listening on http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/)
      if (match) {
        return parseInt(match[1], 10)
      }
    } catch {
      // File may not exist yet
    }
    await sleep(500)
  }
  throw new Error(`Timed out waiting for opencode serve to start (${timeoutMs}ms)`)
}

/**
 * Check on a background agent — fetch recent messages, status, and diff stats.
 */
export async function checkAgent(
  $: Shell,
  registry: AgentRegistry,
  issueId: string,
  lines?: number,
): Promise<string> {
  const agent = registry.get(issueId)
  if (!agent) {
    return JSON.stringify({
      status: "not_found",
      issueId,
      hint: "Agent not in registry. It may have been cleaned up or started before this session.",
    })
  }

  try {
    const limit = lines || 10

    // Get actual session status (running/idle/finished/unreachable)
    const sessionStatus = await getSessionStatus(agent.port, agent.sessionId)

    // Get git diff stat if worktree exists
    let diffStat: string | null = null
    if (agent.worktreePath) {
      diffStat = await getGitDiffStat($, agent.worktreePath)
    }

    const resp = await fetch(
      `http://localhost:${agent.port}/session/${agent.sessionId}/message`,
    )
    if (!resp.ok) {
      return JSON.stringify({
        status: sessionStatus,
        issueId,
        httpStatus: resp.status,
        diffStat,
        agent,
      })
    }

    const messages = (await resp.json()) as any[]
    // Extract text parts from messages
    const texts = messages
      .flatMap((msg: any) => {
        const parts = msg.parts || msg.info?.parts || []
        return parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => ({
            role: msg.info?.role || msg.role || "unknown",
            text: p.text?.slice(0, 500), // Truncate long texts
          }))
      })
      .slice(-limit)

    return JSON.stringify({
      status: sessionStatus,
      issueId,
      port: agent.port,
      tmux: agent.tmuxSession,
      branch: agent.branch,
      diffStat,
      recentMessages: texts,
    })
  } catch (e: any) {
    // Try tmux capture as fallback
    try {
      const tmuxOutput = (
        await $`tmux capture-pane -t ${agent.tmuxSession} -p -S -50`.quiet().text()
      ).trim()
      return JSON.stringify({
        status: "api_unreachable_tmux_fallback",
        issueId,
        tmuxOutput: tmuxOutput.slice(-2000),
        agent,
      })
    } catch {
      return JSON.stringify({
        status: "unreachable",
        issueId,
        error: e?.message || String(e),
        agent,
      })
    }
  }
}

/**
 * Send a follow-up message to a background agent.
 */
export async function followupAgent(
  $: Shell,
  registry: AgentRegistry,
  issueId: string,
  message: string,
): Promise<string> {
  const agent = registry.get(issueId)
  if (!agent) {
    return JSON.stringify({ status: "not_found", issueId })
  }

  try {
    const resp = await fetch(
      `http://localhost:${agent.port}/session/${agent.sessionId}/prompt_async`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text: message }],
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        }),
      },
    )

    return JSON.stringify({
      status: resp.ok ? "sent" : "failed",
      issueId,
      httpStatus: resp.status,
    })
  } catch (e: any) {
    return JSON.stringify({
      status: "error",
      issueId,
      error: e?.message || String(e),
    })
  }
}

/**
 * Abort a background agent's current operation.
 */
export async function abortAgent(
  $: Shell,
  registry: AgentRegistry,
  emitter: LifecycleEmitter,
  issueId: string,
): Promise<string> {
  const agent = registry.get(issueId)
  if (!agent) {
    return JSON.stringify({ status: "not_found", issueId })
  }

  try {
    const resp = await fetch(
      `http://localhost:${agent.port}/session/${agent.sessionId}/abort`,
      { method: "POST" },
    )

    if (resp.ok) {
      await emitter.emit("agent:aborted", { issueId, branch: agent.branch, port: agent.port })
    }

    return JSON.stringify({
      status: resp.ok ? "aborted" : "failed",
      issueId,
      httpStatus: resp.status,
    })
  } catch (e: any) {
    return JSON.stringify({
      status: "error",
      issueId,
      error: e?.message || String(e),
    })
  }
}

/**
 * Clean up a background agent: kill tmux, delete worktree, update lb status.
 * Defaults to force-delete worktree to avoid branch-in-use errors.
 */
export async function cleanupAgent(
  $: Shell,
  registry: AgentRegistry,
  emitter: LifecycleEmitter,
  issueId: string,
  status?: string,
  force?: boolean,
): Promise<string> {
  const agent = registry.get(issueId)
  if (!agent) {
    return JSON.stringify({ status: "not_found", issueId })
  }

  const results: string[] = []

  // Default force to true to handle branch-in-use errors
  const shouldForce = force !== false

  // 1. Kill tmux session
  try {
    await $`tmux kill-session -t ${agent.tmuxSession}`.quiet()
    results.push("tmux killed")
  } catch {
    results.push("tmux already gone")
  }

  // 2. Delete worktree (skip if no worktree was created)
  if (agent.branch !== "(no worktree)") {
    try {
      if (shouldForce) {
        await $`lb worktree delete ${agent.branch} --force`.quiet()
      } else {
        await $`lb worktree delete ${agent.branch}`.quiet()
      }
      results.push("worktree deleted")
    } catch (e: any) {
      results.push(`worktree delete failed: ${e?.message || e}`)
    }
  }

  // 3. Update lb status
  const newStatus = status || "in_review"
  try {
    await $`lb update ${issueId} --status ${newStatus}`.quiet()
    results.push(`status set to ${newStatus}`)
  } catch (e: any) {
    results.push(`status update failed: ${e?.message || e}`)
  }

  // 4. Emit lifecycle event based on final status
  if (newStatus === "in_review") {
    await emitter.emit("agent:finished", { issueId, branch: agent.branch, port: agent.port })
  } else if (newStatus === "done") {
    await emitter.emit("agent:closed", { issueId, branch: agent.branch, port: agent.port })
  }

  // 5. Sync
  try {
    await $`lb sync`.quiet()
    results.push("synced")
  } catch {}

  // 6. Remove from registry
  registry.delete(issueId)

  // 7. Clean up log file
  try {
    await $`rm -f /tmp/opencode-${issueId}.log`.quiet()
  } catch {}

  return JSON.stringify({
    status: "cleaned_up",
    issueId,
    actions: results,
  })
}

/**
 * List all running background agents.
 */
export async function listAgents(
  $: Shell,
  registry: AgentRegistry,
): Promise<string> {
  const agents: any[] = []

  for (const [issueId, agent] of registry.entries()) {
    // Get actual session status
    const sessionStatus = await getSessionStatus(agent.port, agent.sessionId)

    // Check tmux
    let tmuxAlive = false
    try {
      await $`tmux has-session -t ${agent.tmuxSession}`.quiet()
      tmuxAlive = true
    } catch {}

    // Get diff stat
    let diffStat: string | null = null
    if (agent.worktreePath) {
      diffStat = await getGitDiffStat($, agent.worktreePath)
    }

    agents.push({
      issueId,
      port: agent.port,
      sessionId: agent.sessionId,
      tmux: agent.tmuxSession,
      branch: agent.branch,
      reachable: sessionStatus !== "unreachable",
      tmuxAlive,
      sessionStatus,
      diffStat,
      dispatchedAt: agent.dispatchedAt,
    })
  }

  return JSON.stringify({ agents, count: agents.length })
}

/**
 * Reconstruct registry from tmux sessions + lb issue descriptions.
 * Called once on plugin startup to recover state from a previous session.
 */
export async function reconstructRegistry(
  $: Shell,
  registry: AgentRegistry,
): Promise<void> {
  try {
    // Get all in-progress issues from lb (--no-sync: read local cache only, don't hit Linear API)
    // Use Bun.spawn with timeout to prevent zombie processes on startup
    const proc = Bun.spawn(["lb", "list", "--status", "in_progress", "--json", "--no-sync"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LB_TIMEOUT_MS: "10000" },
    })
    const issuesJson = await Promise.race([
      proc.exited.then(async () => {
        return new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer()).trim()
      }),
      new Promise<string>((resolve) => {
        setTimeout(() => {
          proc.kill()
          resolve("")
        }, 10000)
      }),
    ])
    if (!issuesJson || issuesJson === "[]") return

    const issues = JSON.parse(issuesJson) as any[]

    for (const issue of issues) {
      const desc = issue.description || ""
      // Parse "Port: 12345, tmux: AGE_42, session: abc-123"
      const portMatch = desc.match(/Port:\s*(\d+)/)
      const tmuxMatch = desc.match(/tmux:\s*(\S+)/)
      const sessionMatch = desc.match(/session:\s*(\S+)/)

      if (portMatch && tmuxMatch && sessionMatch) {
        const port = parseInt(portMatch[1], 10)
        const tmuxSession = tmuxMatch[1].replace(/,$/g, "")
        const sessionId = sessionMatch[1].replace(/,$/g, "")
        const issueId = issue.identifier || issue.id

        // Verify tmux session is alive
        try {
          await $`tmux has-session -t ${tmuxSession}`.quiet()
        } catch {
          continue // tmux dead, skip
        }

        // Derive branch from issue ID
        const branch = tmuxSession.replace(/_/g, "-")

        registry.set(issueId, {
          issueId,
          port,
          sessionId,
          tmuxSession,
          branch,
          worktreePath: "", // Can't reconstruct reliably, but not needed for API calls
          dispatchedAt: issue.updated_at || new Date().toISOString(),
        })
      }
    }
  } catch {
    // Silent — reconstruction is best-effort
  }
}
