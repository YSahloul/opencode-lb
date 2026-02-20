/**
 * LifecycleEmitter — typed event emitter for agent status transitions.
 *
 * Events:
 *   agent:claimed   — issue picked up (lb update --status in_progress)
 *   agent:running   — dispatch complete, opencode serve is up
 *   agent:finished  — moved to in_review
 *   agent:errored   — agent crashed or unreachable
 *   agent:aborted   — agent aborted
 *   agent:closed    — issue marked done
 */

export type LifecycleEventType =
  | "agent:claimed"
  | "agent:running"
  | "agent:finished"
  | "agent:errored"
  | "agent:aborted"
  | "agent:closed"

export interface LifecyclePayload {
  issueId: string
  branch?: string
  port?: number
  error?: string
  reason?: string
}

export type LifecycleHandler = (payload: LifecyclePayload) => void | Promise<void>

export class LifecycleEmitter {
  private handlers = new Map<LifecycleEventType, LifecycleHandler[]>()

  /**
   * Register a handler for a lifecycle event.
   */
  on(event: LifecycleEventType, handler: LifecycleHandler): void {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
  }

  /**
   * Remove a previously registered handler.
   */
  off(event: LifecycleEventType, handler: LifecycleHandler): void {
    const list = this.handlers.get(event)
    if (!list) return
    const filtered = list.filter((h) => h !== handler)
    this.handlers.set(event, filtered)
  }

  /**
   * Emit a lifecycle event. Handler errors are caught silently.
   */
  async emit(event: LifecycleEventType, payload: LifecyclePayload): Promise<void> {
    const list = this.handlers.get(event) ?? []
    for (const handler of list) {
      try {
        await handler(payload)
      } catch {
        // Silent — handler errors must never break the caller
      }
    }
  }
}
