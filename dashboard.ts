#!/usr/bin/env bun
/**
 * lb dashboard — local HTTP server that serves a live agent dashboard.
 *
 * Usage: bun run dashboard.ts [--port 3333]
 *
 * Auto-discovers all projects with .lb directories under $HOME.
 * Groups issues by project, shows active agents, in review, ready, done.
 * Polls /api/state every 3 seconds.
 */

import { readdir, stat } from "fs/promises"
import { join, basename } from "path"
import { homedir } from "os"

const DASHBOARD_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? "3333", 10)
const HOME = homedir()
const MAX_DEPTH = 3

/**
 * Recursively find directories containing .lb up to MAX_DEPTH.
 */
async function findLbProjects(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return []
  const results: string[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const hasLb = entries.some(e => e.name === ".lb" && e.isDirectory())
    if (hasLb) results.push(dir)

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "Library") continue
      const child = join(dir, entry.name)
      results.push(...await findLbProjects(child, depth + 1))
    }
  } catch {}
  return results
}

/**
 * Run lb list --json in a specific project directory.
 */
async function getLbState(cwd: string): Promise<any[]> {
  try {
    const proc = Bun.spawn(["lb", "list", "--json"], { cwd, stdout: "pipe", stderr: "pipe" })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    const parsed = JSON.parse(text.trim())
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function probeAgent(port: number, sessionId: string): Promise<{ status: string; messageCount: number; lastMessage: string | null }> {
  try {
    const resp = await fetch(`http://localhost:${port}/session/${sessionId}/message`, { signal: AbortSignal.timeout(2000) })
    if (!resp.ok) return { status: "unreachable", messageCount: 0, lastMessage: null }
    const messages = (await resp.json()) as any[]
    if (messages.length === 0) return { status: "idle", messageCount: 0, lastMessage: null }

    const last = messages[messages.length - 1]
    const role = last?.info?.role || last?.role
    const msgStatus = last?.info?.status || last?.status
    const parts = last?.parts || last?.info?.parts || []
    const lastText = parts.find((p: any) => p.type === "text")?.text?.slice(0, 200) ?? null

    let status = "idle"
    if (role === "assistant" && (msgStatus === "completed" || msgStatus === "done")) status = "finished"
    else if (role === "assistant" && msgStatus === "streaming") status = "running"
    else if (role === "user") status = "running"

    return { status, messageCount: messages.length, lastMessage: lastText }
  } catch {
    return { status: "unreachable", messageCount: 0, lastMessage: null }
  }
}

function parseAgentMeta(desc: string): { port: number; tmux: string; session: string } | null {
  const portMatch = desc.match(/Port:\s*(\d+)/)
  const tmuxMatch = desc.match(/tmux:\s*(\S+?)(?:,|$)/)
  const sessionMatch = desc.match(/session:\s*(\S+?)(?:,|$)/)
  if (portMatch && tmuxMatch && sessionMatch) {
    return {
      port: parseInt(portMatch[1], 10),
      tmux: tmuxMatch[1],
      session: sessionMatch[1],
    }
  }
  return null
}

// Cache project paths — rescan every 60 seconds
let cachedProjects: string[] = []
let lastScan = 0

async function getProjects(): Promise<string[]> {
  if (Date.now() - lastScan > 60_000 || cachedProjects.length === 0) {
    cachedProjects = await findLbProjects(HOME)
    lastScan = Date.now()
  }
  return cachedProjects
}

async function buildState() {
  const projects = await getProjects()
  const result: { project: string; path: string; issues: any[] }[] = []

  await Promise.all(
    projects.map(async (projectPath) => {
      const issues = await getLbState(projectPath)
      const enriched = await Promise.all(
        issues.map(async (issue) => {
          const meta = parseAgentMeta(issue.description || "")
          let agent = null
          if (meta && issue.status === "in_progress") {
            agent = { ...meta, ...(await probeAgent(meta.port, meta.session)) }
          }
          return { ...issue, agent }
        })
      )
      if (enriched.length > 0) {
        result.push({
          project: basename(projectPath),
          path: projectPath,
          issues: enriched,
        })
      }
    })
  )

  // Sort: projects with active agents first
  result.sort((a, b) => {
    const aActive = a.issues.filter(i => i.status === "in_progress").length
    const bActive = b.issues.filter(i => i.status === "in_progress").length
    return bActive - aActive
  })

  return result
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lb dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
    background: #0a0a0a;
    color: #e0e0e0;
    padding: 24px;
    min-height: 100vh;
  }
  h1 {
    font-size: 14px;
    font-weight: 600;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 2px;
    margin-bottom: 24px;
  }
  .meta {
    font-size: 11px;
    color: #444;
    margin-bottom: 20px;
  }
  .counts {
    display: flex;
    gap: 12px;
    margin-bottom: 24px;
    flex-wrap: wrap;
  }
  .count-box {
    padding: 10px 16px;
    background: #111;
    border: 1px solid #222;
    border-radius: 6px;
    text-align: center;
    min-width: 72px;
  }
  .count-box .num {
    font-size: 22px;
    font-weight: 700;
    color: #fff;
  }
  .count-box .lbl {
    font-size: 9px;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-top: 2px;
  }

  /* Project sections */
  .project {
    margin-bottom: 32px;
  }
  .project-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 4px;
  }
  .project-name {
    font-size: 16px;
    font-weight: 700;
    color: #fff;
  }
  .project-path {
    font-size: 10px;
    color: #333;
  }
  .project-counts {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }
  .project-counts .pc {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
  }
  .pc.active { background: #1a3a2a; color: #4ade80; }
  .pc.review { background: #1a2a3a; color: #60a5fa; }
  .pc.ready { background: #2a2a1a; color: #facc15; }
  .pc.done-c { background: #151515; color: #555; }

  /* Status groups within project */
  .status-group {
    margin: 12px 0 8px;
  }
  .status-label {
    font-size: 10px;
    font-weight: 600;
    color: #444;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 8px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: 10px;
  }

  /* Cards */
  .card {
    background: #111;
    border: 1px solid #222;
    border-radius: 8px;
    padding: 14px;
    transition: border-color 0.2s;
  }
  .card:hover { border-color: #333; }
  .card.active-card { border-color: #1a3a2a; }
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .issue-id {
    font-size: 13px;
    font-weight: 700;
    color: #fff;
  }
  .badge {
    font-size: 9px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .badge.in_progress { background: #1a3a2a; color: #4ade80; }
  .badge.in_review { background: #1a2a3a; color: #60a5fa; }
  .badge.done { background: #151515; color: #666; }
  .badge.todo_refined { background: #2a2a1a; color: #facc15; }
  .badge.todo_needs_refinement { background: #2a1a1a; color: #f87171; }
  .badge.todo_bug { background: #2a1a1a; color: #fb923c; }
  .title {
    font-size: 11px;
    color: #999;
    margin-bottom: 6px;
    line-height: 1.4;
  }
  .agent-status {
    font-size: 10px;
    padding: 6px 8px;
    background: #0a0f0a;
    border: 1px solid #1a2a1a;
    border-radius: 4px;
    margin-top: 6px;
  }
  .agent-status .label { color: #555; }
  .agent-status .val { color: #4ade80; }
  .agent-status .val.running { color: #facc15; }
  .agent-status .val.finished { color: #60a5fa; }
  .agent-status .val.unreachable { color: #f87171; }
  .agent-status .val.idle { color: #888; }
  .last-msg {
    font-size: 9px;
    color: #444;
    margin-top: 4px;
    line-height: 1.3;
    max-height: 36px;
    overflow: hidden;
  }
  .time {
    font-size: 9px;
    color: #333;
    margin-top: 4px;
  }
  .pulse {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    margin-right: 5px;
    animation: pulse 2s infinite;
  }
  .pulse.live { background: #4ade80; }
  .pulse.working { background: #facc15; }
  .pulse.dead { background: #f87171; animation: none; }
  .pulse.off { background: #333; animation: none; }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .empty {
    color: #333;
    font-size: 12px;
    padding: 40px;
    text-align: center;
  }
  .done-toggle {
    font-size: 10px;
    color: #444;
    cursor: pointer;
    user-select: none;
    margin-top: 8px;
  }
  .done-toggle:hover { color: #666; }
  .collapsed { display: none; }
  .btn-tmux {
    display: inline-block;
    font-size: 9px;
    font-weight: 600;
    padding: 3px 8px;
    margin-top: 6px;
    background: #1a2a1a;
    color: #4ade80;
    border: 1px solid #2a3a2a;
    border-radius: 4px;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .btn-tmux:hover { background: #2a3a2a; border-color: #4ade80; }
  .card-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  .project-divider {
    border: none;
    border-top: 1px solid #1a1a1a;
    margin: 24px 0 0;
  }
</style>
</head>
<body>
<h1>lb agent dashboard</h1>
<div class="meta" id="meta">loading...</div>
<div class="counts" id="counts"></div>
<div id="projects"></div>

<script>
const STATUS_ORDER = ['in_progress', 'in_review', 'todo_refined', 'todo_bug', 'todo_needs_refinement', 'done']
const STATUS_LABELS = {
  in_progress: 'Active',
  in_review: 'In Review',
  todo_refined: 'Ready',
  todo_bug: 'Bug',
  todo_needs_refinement: 'Needs Refinement',
  done: 'Done'
}

// Track which projects have done collapsed
const doneCollapsed = {}

function timeAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return mins + 'm ago'
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return hrs + 'h ago'
  return Math.floor(hrs / 24) + 'd ago'
}

function pulseClass(agent) {
  if (!agent) return 'off'
  if (agent.status === 'running') return 'working'
  if (agent.status === 'finished' || agent.status === 'idle') return 'live'
  return 'dead'
}

function esc(s) {
  if (!s) return ''
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

function openTmux(session) {
  fetch('/api/tmux', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: session })
  })
}

function renderCard(issue) {
  const a = issue.agent
  const isActive = issue.status === 'in_progress'
  let agentHtml = ''
  if (a) {
    agentHtml = '<div class="agent-status">' +
      '<span class="pulse ' + pulseClass(a) + '"></span>' +
      '<span class="label">status:</span> <span class="val ' + a.status + '">' + a.status + '</span>' +
      ' &middot; <span class="label">port:</span> <span class="val">' + a.port + '</span>' +
      ' &middot; <span class="label">msgs:</span> <span class="val">' + a.messageCount + '</span>' +
      (a.lastMessage ? '<div class="last-msg">' + esc(a.lastMessage) + '</div>' : '') +
      '</div>' +
      '<div class="card-actions">' +
        '<span class="btn-tmux" onclick="openTmux(\\'' + esc(a.tmux) + '\\')">open tmux</span>' +
      '</div>'
  }
  return '<div class="card' + (isActive ? ' active-card' : '') + '">' +
    '<div class="card-header">' +
      '<span class="issue-id">' + (a ? '<span class="pulse ' + pulseClass(a) + '"></span>' : '') + issue.id + '</span>' +
      '<span class="badge ' + issue.status + '">' + issue.status.replace(/_/g, ' ') + '</span>' +
    '</div>' +
    '<div class="title">' + esc(issue.title) + '</div>' +
    agentHtml +
    '<div class="time">updated ' + timeAgo(issue.updated_at) + '</div>' +
    '</div>'
}

function toggleDone(project) {
  doneCollapsed[project] = !doneCollapsed[project]
  refresh()
}

async function refresh() {
  try {
    const resp = await fetch('/api/state')
    const projects = await resp.json()

    // Global counts
    let totalActive = 0, totalReview = 0, totalReady = 0, totalDone = 0, totalAgents = 0
    projects.forEach(p => {
      p.issues.forEach(i => {
        if (i.status === 'in_progress') totalActive++
        if (i.status === 'in_review') totalReview++
        if (i.status === 'todo_refined' || i.status === 'todo_bug') totalReady++
        if (i.status === 'done') totalDone++
        if (i.agent && i.agent.status !== 'unreachable') totalAgents++
      })
    })

    document.getElementById('counts').innerHTML =
      '<div class="count-box"><div class="num">' + totalAgents + '</div><div class="lbl">Live Agents</div></div>' +
      '<div class="count-box"><div class="num">' + totalActive + '</div><div class="lbl">Active</div></div>' +
      '<div class="count-box"><div class="num">' + totalReview + '</div><div class="lbl">Review</div></div>' +
      '<div class="count-box"><div class="num">' + totalReady + '</div><div class="lbl">Ready</div></div>' +
      '<div class="count-box"><div class="num">' + projects.length + '</div><div class="lbl">Projects</div></div>' +
      '<div class="count-box"><div class="num">' + totalDone + '</div><div class="lbl">Done</div></div>'

    // Render projects
    let html = ''
    projects.forEach(p => {
      const grouped = {}
      p.issues.forEach(i => {
        if (!grouped[i.status]) grouped[i.status] = []
        grouped[i.status].push(i)
      })

      const nActive = (grouped.in_progress || []).length
      const nReview = (grouped.in_review || []).length
      const nReady = (grouped.todo_refined || []).length + (grouped.todo_bug || []).length
      const nDone = (grouped.done || []).length

      html += '<div class="project">'
      html += '<div class="project-header">'
      html += '<span class="project-name">' + esc(p.project) + '</span>'
      html += '<span class="project-path">' + esc(p.path.replace(/^\\/Users\\/\\w+/, '~')) + '</span>'
      html += '<div class="project-counts">'
      if (nActive) html += '<span class="pc active">' + nActive + ' active</span>'
      if (nReview) html += '<span class="pc review">' + nReview + ' review</span>'
      if (nReady) html += '<span class="pc ready">' + nReady + ' ready</span>'
      if (nDone) html += '<span class="pc done-c">' + nDone + ' done</span>'
      html += '</div></div>'

      STATUS_ORDER.forEach(status => {
        const items = grouped[status]
        if (!items || items.length === 0) return

        if (status === 'done') {
          const collapsed = doneCollapsed[p.project] !== false
          html += '<div class="done-toggle" onclick="toggleDone(\\''+esc(p.project)+'\\')">'+
            (collapsed ? '\\u25B6' : '\\u25BC') + ' Done (' + items.length + ')</div>'
          html += '<div class="status-group' + (collapsed ? ' collapsed' : '') + '">'
        } else {
          html += '<div class="status-group">'
          html += '<div class="status-label">' + (STATUS_LABELS[status] || status) + '</div>'
        }

        html += '<div class="grid">'
        items.forEach(i => { html += renderCard(i) })
        html += '</div></div>'
      })

      html += '<hr class="project-divider">'
      html += '</div>'
    })

    if (!html) html = '<div class="empty">No projects found. Run lb onboard in a project to get started.</div>'
    document.getElementById('projects').innerHTML = html
    document.getElementById('meta').textContent = 'Last updated: ' + new Date().toLocaleTimeString() +
      ' \\u00b7 ' + projects.length + ' projects \\u00b7 polling every 3s'
  } catch (e) {
    document.getElementById('meta').textContent = 'Error: ' + e.message
  }
}

// Start with done collapsed
refresh()
setInterval(refresh, 3000)
</script>
</body>
</html>`

Bun.serve({
  port: DASHBOARD_PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/api/state") {
      const state = await buildState()
      return new Response(JSON.stringify(state), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      })
    }

    // Open tmux session in a new Terminal.app window
    if (url.pathname === "/api/tmux" && req.method === "POST") {
      try {
        const body = await req.json() as { session: string }
        const session = body.session?.replace(/[^a-zA-Z0-9_-]/g, "")
        if (!session) return new Response("missing session", { status: 400 })
        // Open a new Terminal window that attaches to the tmux session
        Bun.spawn(["osascript", "-e",
          `tell application "Terminal"
            activate
            do script "tmux attach-session -t ${session}"
          end tell`
        ])
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        })
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e?.message }), { status: 500 })
      }
    }

    return new Response(HTML, {
      headers: { "Content-Type": "text/html" },
    })
  },
})

console.log(`lb dashboard running at http://localhost:${DASHBOARD_PORT}`)
