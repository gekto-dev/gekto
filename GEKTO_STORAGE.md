# .gekto Entity Store Gaps — Fix Summary

## What was done

Fixed gaps in the `.gekto/` file-based state mirror so agents reading from disk get accurate, complete information.

## Changes by file

### `server/src/entityStore.ts`

1. **Rich `rebuildOverview()`** — `overview.json` now includes `currentMasterId`, full agent details (planId, personaId, createdAt, completedAt, fileChangeCount), full task details (description, dependencies, files, error, truncated result), full plan details (title, taskIds, createdAt, completedAt), and all fileChanges (tool, filePath, agentId, taskId, timestamp).

2. **Bulk task clear** — `persistMutation` now handles `mutate('tasks', {})` by deleting all `.json` files in `.gekto/tasks/`.

3. **Agent soft-delete writes 'done'** — When `mutate('agents.${id}', undefined)` fires, the agent file on disk is updated to `status: 'done'` with `completedAt` instead of being left with stale status.

### `server/src/state.ts`

4. **fileChanges triggers overview rebuild** — Both `mutate()` and `mutateBatch()` now rebuild `overview.json` when `fileChanges.*` paths are mutated.
    
### `server/src/agents/agentWebSocket.ts`

5. **`task_completed`** — Also sets the assigned agent's status to `done` with `completedAt`.

6. **`task_failed`** — Also sets the assigned agent's status to `error`.

7. **`mark_task_resolved`** — Persists agent as `done` to disk (via `persistEntity`) before removing from memory.

8. **`create_plan` remove path** — Same `persistEntity` 'done' write before `mutate(undefined)` for removed agents.

9. **`kill` handler** — Sets killed worker agent status to `error` in server state.

10. **`revert_files`** — Now also cleans up `fileChangePaths` on the agent and removes top-level `fileChanges.*` entries for reverted files.

## Build status

Compiles cleanly. Only pre-existing TS error is an unrelated `ws.send` typing issue on line 70 of `agentWebSocket.ts`.

## Type workarounds

- `ExecutionPlan` has no `completedAt` field — cast via `unknown` to access it in overview (it gets set at runtime via `mutateBatch`).
- `task.result.slice()` needed an intermediate variable to satisfy TS narrowing.
