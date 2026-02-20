/**
 * Orchestration logic — dispatch, check, followup, abort, cleanup, reconstruct.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { AgentRegistry } from "./registry"

type Shell = PluginInput["$"]

/**
 * Dispatch an issue to a background worktree agent.
 * Creates worktree, launches opencode serve in tmux, sends the prompt.
 */
export async function dispatch(
  $: Shell,
  registry: AgentRegistry,
  args: {
    issueId: string
    prompt: string
    model?: string
    provider?: string
    slug?: string
  },
): Promise<string> {
  const { issueId, prompt, model, provider, slug } = args
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
    // 1. Claim the issue
    await $`lb update ${issueId} --status in_progress`.quiet()

    // 2. Create worktree
    await $`lb worktree create ${branch}`.quiet()

    // 3. Resolve worktree path (sibling of current repo root)
    const repoRoot = (await $`git rev-parse --show-toplevel`.quiet().text()).trim()
    const parentDir = (await $`dirname ${repoRoot}`.quiet().text()).trim()
    const wtPath = `${parentDir}/${branch}`

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

    // 7. Send the task prompt
    await fetch(`http://localhost:${port}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: prompt }],
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
      branch,
      worktreePath: wtPath,
      dispatchedAt: new Date().toISOString(),
    }
    registry.set(issueId, entry)

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
 * Check on a background agent — fetch recent messages.
 */
export async function checkAgent(
  $: Shell,
  registry: AgentRegistry,
  issueId: string,
  lines?: number,
): Promise<string> {
  const agent = registry.get(issueId)
  if (!agent) {
    // Try to reconstruct from lb issue description
    return JSON.stringify({
      status: "not_found",
      issueId,
      hint: "Agent not in registry. It may have been cleaned up or started before this session.",
    })
  }

  try {
    const limit = lines || 10
    const resp = await fetch(
      `http://localhost:${agent.port}/session/${agent.sessionId}/message?limit=${limit}`,
    )
    if (!resp.ok) {
      return JSON.stringify({
        status: "unreachable",
        issueId,
        httpStatus: resp.status,
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
      status: "running",
      issueId,
      port: agent.port,
      tmux: agent.tmuxSession,
      branch: agent.branch,
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
 */
export async function cleanupAgent(
  $: Shell,
  registry: AgentRegistry,
  issueId: string,
  status?: string,
  force?: boolean,
): Promise<string> {
  const agent = registry.get(issueId)
  if (!agent) {
    return JSON.stringify({ status: "not_found", issueId })
  }

  const results: string[] = []

  // 1. Kill tmux session
  try {
    await $`tmux kill-session -t ${agent.tmuxSession}`.quiet()
    results.push("tmux killed")
  } catch {
    results.push("tmux already gone")
  }

  // 2. Delete worktree
  try {
    if (force) {
      await $`lb worktree delete ${agent.branch} --force`.quiet()
    } else {
      await $`lb worktree delete ${agent.branch}`.quiet()
    }
    results.push("worktree deleted")
  } catch (e: any) {
    results.push(`worktree delete failed: ${e?.message || e}`)
  }

  // 3. Update lb status
  const newStatus = status || "in_review"
  try {
    await $`lb update ${issueId} --status ${newStatus}`.quiet()
    results.push(`status set to ${newStatus}`)
  } catch (e: any) {
    results.push(`status update failed: ${e?.message || e}`)
  }

  // 4. Sync
  try {
    await $`lb sync`.quiet()
    results.push("synced")
  } catch {}

  // 5. Remove from registry
  registry.delete(issueId)

  // 6. Clean up log file
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
    let reachable = false
    let sessionStatus = "unknown"

    try {
      const resp = await fetch(
        `http://localhost:${agent.port}/session/${agent.sessionId}/status`,
      )
      if (resp.ok) {
        reachable = true
        const data = (await resp.json()) as any
        sessionStatus = data?.status || (data?.idle ? "idle" : "running")
      }
    } catch {}

    // Also check tmux
    let tmuxAlive = false
    try {
      await $`tmux has-session -t ${agent.tmuxSession}`.quiet()
      tmuxAlive = true
    } catch {}

    agents.push({
      issueId,
      port: agent.port,
      sessionId: agent.sessionId,
      tmux: agent.tmuxSession,
      branch: agent.branch,
      reachable,
      tmuxAlive,
      sessionStatus,
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
    // Get all in-progress issues from lb
    const issuesJson = (
      await $`lb list --status in_progress --json`.quiet().text()
    ).trim()
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
