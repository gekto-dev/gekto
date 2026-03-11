import { useState, useRef, useMemo } from 'react'
import { ListBulletIcon } from '@radix-ui/react-icons'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useGekto, usePlanTasks, type Task } from '../context/GektoContext'
import { useAgent, type FileChange } from '../context/AgentContext'
import { DiffModal } from './whiteboard/DiffModal'
import { ChatWindow } from './ChatWindow'

interface GektoPlanPanelProps {
  position: { x: number; y: number }
  height?: number
  onClose: () => void
}

// Tree node for rendering task hierarchy
interface TaskTreeNode {
  task: Task
  children: TaskTreeNode[]
  depth: number
  isLast: boolean // last child at this level
  connectorFlags: boolean[] // which ancestor levels have a continuing vertical line
}

function buildTaskTree(tasks: Task[]): TaskTreeNode[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]))

  // Find which tasks are children (depended upon by others)
  // A task's "parent" is its first dependency (for tree display purposes)
  const childrenOf = new Map<string, string[]>() // parentId -> childTaskIds
  const hasParent = new Set<string>()

  for (const task of tasks) {
    if (task.dependencies.length > 0) {
      // Use the last dependency as the tree parent (deepest in chain)
      const parentId = task.dependencies[task.dependencies.length - 1]
      if (taskMap.has(parentId)) {
        const children = childrenOf.get(parentId) || []
        children.push(task.id)
        childrenOf.set(parentId, children)
        hasParent.add(task.id)
      }
    }
  }

  // Root tasks = tasks with no dependencies or whose dependencies aren't in the task list
  const roots = tasks.filter(t => !hasParent.has(t.id))

  function buildNodes(taskIds: string[], depth: number, connectorFlags: boolean[]): TaskTreeNode[] {
    return taskIds
      .map(id => taskMap.get(id))
      .filter((t): t is Task => !!t)
      .map((task, i, arr) => {
        const isLast = i === arr.length - 1
        const children = childrenOf.get(task.id) || []
        const nextFlags = depth > 0 ? [...connectorFlags, !isLast] : connectorFlags
        return {
          task,
          depth,
          isLast,
          connectorFlags,
          children: buildNodes(children, depth + 1, nextFlags),
        }
      })
  }

  return buildNodes(roots.map(t => t.id), 0, [])
}

function flattenTree(nodes: TaskTreeNode[]): TaskTreeNode[] {
  const result: TaskTreeNode[] = []
  for (const node of nodes) {
    result.push(node)
    result.push(...flattenTree(node.children))
  }
  return result
}

interface TaskRowProps {
  task: Task
  allTasks: Task[]
  treeNode?: TaskTreeNode
  onMarkResolved?: (taskId: string) => void
  onRun?: (taskId: string) => void
  onStop?: (taskId: string) => void
  onRemove?: (taskId: string) => void
  onShowPrompt?: (task: Task) => void
  onShowDiff?: (agentId: string) => void
  onOpenChat?: (agentId: string) => void
}

function TaskRow({ task, allTasks, treeNode, onMarkResolved, onRun, onStop, onRemove, onShowPrompt, onShowDiff, onOpenChat }: TaskRowProps) {
  const depth = treeNode?.depth ?? 0

  // Check if this pending task has all dependencies satisfied (ready to run)
  // A dep is "done" when agent finished (pending_testing) or user approved (completed)
  const depsReady = task.status === 'pending' && task.dependencies.length > 0 &&
    task.dependencies.every(depId => {
      const dep = allTasks.find(t => t.id === depId)
      return dep?.status === 'completed' || dep?.status === 'pending_testing'
    })

  const handleMarkResolved = () => {
    onMarkResolved?.(task.id)
  }

  const getBackgroundStyle = () => {
    if (depsReady) return { bg: 'rgba(74, 222, 128, 0.08)', border: '1px solid rgba(74, 222, 128, 0.2)' }
    switch (task.status) {
      case 'in_progress':
        return { bg: 'rgba(255, 255, 255, 0.04)', border: '1px solid rgba(255, 255, 255, 0.08)' }
      case 'pending_testing':
        return { bg: 'rgba(255, 255, 255, 0.04)', border: '1px solid rgba(255, 255, 255, 0.08)' }
      case 'completed':
        return { bg: 'rgba(34, 197, 94, 0.05)', border: '1px solid rgba(255, 255, 255, 0.05)' }
      case 'failed':
        return { bg: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)' }
      default:
        return { bg: 'rgba(255, 255, 255, 0.02)', border: '1px solid rgba(255, 255, 255, 0.05)' }
    }
  }

  const style = getBackgroundStyle()

  const INDENT = 20

  return (
    <div className="flex items-stretch">
      {/* Tree connector lines */}
      {treeNode && depth > 0 && (
        <>
          {/* Ancestor continuation lines */}
          {treeNode.connectorFlags.map((hasContinuation, i) => (
            <div key={i} className="shrink-0 relative" style={{ width: INDENT }}>
              {hasContinuation && (
                <div style={{
                  position: 'absolute', left: INDENT / 2, top: 0, bottom: 0,
                  width: 1, background: 'rgba(255, 255, 255, 0.12)',
                }} />
              )}
            </div>
          ))}
          {/* Branch connector: vertical + horizontal */}
          <div className="shrink-0 relative" style={{ width: INDENT }}>
            <div style={{
              position: 'absolute', left: INDENT / 2, top: 0,
              height: treeNode.isLast ? '50%' : '100%',
              width: 1, background: 'rgba(255, 255, 255, 0.12)',
            }} />
            <div style={{
              position: 'absolute', left: INDENT / 2, top: '50%',
              width: INDENT / 2, height: 1, background: 'rgba(255, 255, 255, 0.12)',
            }} />
          </div>
        </>
      )}
      <div
        className={`flex-1 min-w-0 flex items-start gap-3 p-3 transition-all duration-300 rounded${task.status === 'in_progress' ? ' task-shimmer' : ''}`}
        style={{
          ...( task.status !== 'in_progress' ? { background: style.bg } : {}),
          border: style.border,
        }}
      >
      <div className="flex-1 min-w-0 relative">
        {/* Play/Pause & Remove buttons — top right corner */}
        {task.status !== 'completed' && (
          <div className="absolute top-0 right-0 flex items-center gap-1.5">
            {task.status === 'in_progress' ? (
              <button
                onClick={() => onStop?.(task.id)}
                className="w-6 h-6 flex items-center justify-center transition-all text-white/40 hover:text-white cursor-pointer"
                title="Pause task"
              >
                <svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor">
                  <rect x="0" y="0" width="2.5" height="10" rx="0.5" />
                  <rect x="5.5" y="0" width="2.5" height="10" rx="0.5" />
                </svg>
              </button>
            ) : (
              <button
                onClick={() => onRun?.(task.id)}
                disabled={task.status === 'completed' || task.status === 'pending_testing' || !task.prompt || (task.dependencies.length > 0 && !depsReady)}
                className="w-6 h-6 flex items-center justify-center transition-all text-white/40 hover:text-white pl-px cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed"
                title={task.dependencies.length > 0 && !depsReady ? 'Waiting for dependencies' : 'Run task'}
              >
                <svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor">
                  <path d="M1 0.5a.5.5 0 0 1 .77-.42l5.73 3.57a.5.5 0 0 1 0 .84L1.77 8.06A.5.5 0 0 1 1 7.64V0.5Z" />
                </svg>
              </button>
            )}
            <button
              onClick={() => onRemove?.(task.id)}
              className="w-6 h-6 flex items-center justify-center transition-all text-white/40 hover:text-white cursor-pointer"
              title="Remove task"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M2 2l6 6M8 2l-6 6" />
              </svg>
            </button>
          </div>
        )}

        {/* Task name (short title) + description */}
        <div className="mb-1">
          <div
            className="text-white text-sm font-medium pr-14"
          >
            {task.name || task.description}
          </div>
          {task.name && task.description && task.name !== task.description && (
            <div
              className="text-white/50 text-sm whitespace-pre-wrap mt-1.5"
              style={{ wordBreak: 'break-word' }}
            >
              {task.description}
            </div>
          )}
        </div>

        {/* Prompt button and resolve */}
        <div className="flex items-center gap-2 mt-2">
          {task.status === 'pending' || task.status === 'failed' ? (
            <button
              onClick={() => task.prompt && onShowPrompt?.(task)}
              disabled={!task.prompt}
              className="flex items-center gap-1.5 px-2 py-1 text-xs transition-all disabled:opacity-30 disabled:cursor-not-allowed rounded"
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                color: 'rgba(255, 255, 255, 0.5)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }}
            >
              <ListBulletIcon width={12} height={12} />
              <span>Agent Prompt</span>
            </button>
          ) : (
            <button
              onClick={() => task.prompt && onShowPrompt?.(task)}
              disabled={!task.prompt}
              className="w-6 h-6 flex items-center justify-center transition-all text-white/40 hover:text-white disabled:opacity-20 disabled:cursor-not-allowed cursor-pointer rounded"
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }}
              title="View agent prompt"
            >
              <ListBulletIcon width={12} height={12} />
            </button>
          )}
          {/* Diff button — show when agent has been assigned */}
          {task.assignedAgentId && (
            <button
              onClick={() => onShowDiff?.(task.assignedAgentId!)}
              className="w-6 h-6 flex items-center justify-center transition-all text-white/40 hover:text-white cursor-pointer rounded"
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }}
              title="View file changes"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </button>
          )}
          {/* Chat button — show when agent has been assigned */}
          {task.assignedAgentId && (
            <button
              onClick={() => onOpenChat?.(task.assignedAgentId!)}
              className="w-6 h-6 flex items-center justify-center transition-all text-white/40 hover:text-white cursor-pointer rounded"
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }}
              title="Open agent chat"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          )}
          {task.status === 'pending_testing' && (
            <button
              onClick={handleMarkResolved}
              className="px-2 py-1 text-xs transition-colors rounded"
              style={{
                background: 'linear-gradient(to right bottom, rgba(34, 197, 94, 0.15), rgba(74, 222, 128, 0.35))',
                color: 'rgb(114, 222, 128)',
                border: '1px solid rgba(34, 197, 94, 0.2)',
              }}
            >
              Mark Resolved
            </button>
          )}
        </div>

        {task.error && (
          <div className="text-xs text-red-400 mt-1">
            {task.error}
          </div>
        )}
      </div>
      </div>
    </div>
  )
}

export function GektoPlanPanel({ position, height, onClose }: GektoPlanPanelProps) {
  const [modalPrompt, setModalPrompt] = useState<Task | null>(null)
  const [diffAgentId, setDiffAgentId] = useState<string | null>(null)
  const [chatAgentId, setChatAgentId] = useState<string | null>(null)
  const { currentPlan, generateTasks, executePlan, buildPlan, cancelPlan, markTaskResolved, runTask, runAvailableTasks, removeTask } = useGekto()
  const tasks = usePlanTasks()
  const { killAgent, getFileChanges, revertFiles } = useAgent()

  const diffFileChanges: FileChange[] = diffAgentId ? getFileChanges(diffAgentId) : []

  const hasTasks = tasks.length > 0
  const isDraft = currentPlan?.status === 'draft'
  const isGeneratingTasks = currentPlan?.status === 'generating_prompts'
  const isPlanning = currentPlan?.status === 'planning'
  const [activeTab, setActiveTab] = useState<'abstract' | 'tasks'>('abstract')

  // Auto-switch to tasks tab when tasks appear or generation starts
  const prevHasTasks = useRef(hasTasks)
  if (hasTasks && !prevHasTasks.current) {
    setActiveTab('tasks')
  }
  prevHasTasks.current = hasTasks

  const prevGenerating = useRef(isGeneratingTasks)
  if (isGeneratingTasks && !prevGenerating.current) {
    setActiveTab('tasks')
  }
  prevGenerating.current = isGeneratingTasks

  // Build task tree for hierarchical rendering
  const taskTreeFlat = useMemo(() => flattenTree(buildTaskTree(tasks)), [tasks])

  if (!currentPlan) return null

  const completedCount = tasks.filter(t => t.status === 'completed').length
  // A dep is "done" if agent finished (pending_testing) or user approved (completed)
  const doneTaskIds = new Set(tasks.filter(t => t.status === 'completed' || t.status === 'pending_testing').map(t => t.id))
  const availableToRun = tasks.filter(t => {
    if (t.status !== 'pending') return false
    return t.dependencies.every(depId => doneTaskIds.has(depId))
  })
  const pendingTestingCount = tasks.filter(t => t.status === 'pending_testing').length
  const totalCount = tasks.length
  const progress = totalCount > 0 ? (completedCount / totalCount) * 100 : 0

  // Show Build button when all tasks are done (pending_testing or completed), and buildPrompt exists
  const allTasksDone = totalCount > 0 && tasks.every(t => t.status === 'completed' || t.status === 'pending_testing')
  const showBuildButton = !!currentPlan.buildPrompt && (
    allTasksDone ||
    tasks.length === 0 ||
    currentPlan.status === 'completed'
  )

  return (
    <div
      className="fixed"
      data-swarm-ui
      style={{
        left: position.x,
        top: position.y,
        zIndex: 1003,
        width: 520,
        height: height || 500,
        pointerEvents: 'auto',
      }}
    >
      <div
        className="flex flex-col overflow-hidden rounded-lg h-full"
        style={{
          background: 'linear-gradient(135deg, rgb(35, 35, 45), rgb(45, 45, 55))',
          backdropFilter: 'blur(12px) saturate(180%)',
          WebkitBackdropFilter: 'blur(12px) saturate(180%)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.1)' }}
        >
          <div className="flex items-baseline gap-2">
            <span className="text-white font-medium text-sm">Plan</span>
            {isDraft && (
              <span className="text-xs text-white/40">Draft</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {showBuildButton && (
              <button
                onClick={() => buildPlan()}
                className="px-3 py-1 text-xs font-medium transition-colors rounded"
                style={{
                  background: 'linear-gradient(to right bottom, rgba(34, 197, 94, 0.15), rgba(74, 222, 128, 0.35))',
                  color: 'rgb(114, 222, 128)',
                  border: '1px solid rgba(34, 197, 94, 0.2)',
                }}
              >
                Build
              </button>
            )}
            <button
              onClick={onClose}
              className="text-white/60 hover:text-white transition-colors w-6 h-6 flex items-center justify-center hover:bg-white/10 rounded"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex items-center gap-2 px-4 pt-3 pb-2">
          <button
            onClick={() => setActiveTab('abstract')}
            className="px-3 py-1 text-xs font-medium rounded-full transition-all"
            style={activeTab === 'abstract' ? {
              background: 'rgba(74, 222, 128, 0.15)',
              color: 'rgb(134, 239, 172)',
            } : {
              background: 'rgba(255, 255, 255, 0.06)',
              color: 'rgba(255, 255, 255, 0.5)',
            }}
          >
            <span className={isPlanning ? 'shimmer-text' : ''}>Description</span>
          </button>
          <button
            onClick={() => setActiveTab('tasks')}
            className="px-3 py-1 text-xs font-medium rounded-full transition-all"
            style={activeTab === 'tasks' ? {
              background: 'rgba(74, 222, 128, 0.15)',
              color: 'rgb(134, 239, 172)',
            } : {
              background: 'rgba(255, 255, 255, 0.06)',
              color: 'rgba(255, 255, 255, 0.5)',
            }}
          >
            <span className={isGeneratingTasks ? 'shimmer-text' : ''}>
              Tasks{totalCount > 0 ? ` ${totalCount}` : ''}
            </span>
          </button>
        </div>

        {/* Tab content */}
        <div className="flex-1 p-3 overflow-y-auto min-h-0">

          {/* Abstract tab */}
          {activeTab === 'abstract' && (
            <>
              {currentPlan.status === 'planning' && !currentPlan.abstract && (
                <div className="flex items-center justify-center py-8">
                  <div className="flex items-center gap-2">
                    <span style={{ color: '#4ade80', fontSize: '14px', animation: 'blink-triangle 1.2s ease-in-out infinite' }}>◆</span>
                    <span className="shimmer-text font-mono text-xs">Analyzing and writing plan</span>
                  </div>
                </div>
              )}
              {currentPlan.abstract && (
                <div className="px-1 text-sm plan-abstract">
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      p: ({ children }) => <p className="text-white/70 leading-relaxed mb-3 last:mb-0">{children}</p>,
                      strong: ({ children }) => <strong className="text-white/90 font-semibold block mb-1">{children}</strong>,
                      ul: ({ children }) => <ul className="text-white/60 list-disc pl-4 mb-3 last:mb-0 space-y-0.5">{children}</ul>,
                      ol: ({ children }) => <ol className="text-white/60 list-decimal pl-4 mb-3 last:mb-0 space-y-0.5">{children}</ol>,
                      li: ({ children }) => <li className="text-white/60 leading-relaxed">{children}</li>,
                      code: ({ children }) => {
                        const text = typeof children === 'string' ? children : String(children ?? '')
                        const isPath = text.includes('/') && !text.includes(' ')
                        const display = isPath ? text.split('/').slice(-2).join('/') : text
                        return <code className="text-[#BFFF6B] text-xs px-1 py-0.5 rounded" title={isPath ? text : undefined} style={{ background: 'rgba(255,255,255,0.06)' }}>{display}</code>
                      },
                      blockquote: ({ children }) => <blockquote className="mb-4 pl-3 text-white/60" style={{ borderLeft: '3px solid rgba(255, 255, 255, 0.2)' }}>{children}</blockquote>,
                      h1: ({ children }) => <h2 className="text-white font-semibold text-base mb-2">{children}</h2>,
                      h2: ({ children }) => <h3 className="text-white font-semibold text-sm mb-2">{children}</h3>,
                      h3: ({ children }) => <h4 className="text-white/90 font-medium text-sm mb-1">{children}</h4>,
                    }}
                  >
                    {currentPlan.abstract}
                  </Markdown>
                </div>
              )}
            </>
          )}

          {/* Tasks tab */}
          {activeTab === 'tasks' && (
            <>
              {/* Execution progress bar */}
              {currentPlan.status === 'executing' && (
                <div className="px-1 py-1 mb-2">
                  <div className="flex items-center gap-2 text-xs text-white/60 mb-1">
                    <span>Progress</span>
                    <span>{completedCount}/{totalCount}</span>
                    {pendingTestingCount > 0 && (
                      <span className="text-green-300">({pendingTestingCount} pending review)</span>
                    )}
                  </div>
                  <div
                    className="h-1 rounded-full overflow-hidden"
                    style={{ background: 'rgba(255, 255, 255, 0.1)' }}
                  >
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${progress}%`,
                        background: 'linear-gradient(90deg, #BFFF6B, #6BFF9B)',
                      }}
                    />
                  </div>
                </div>
              )}

              {isGeneratingTasks && !hasTasks && (
                <div className="space-y-2 h-full">
                  {[
                    { w: 0.8, indent: 0 },
                    { w: 0.6, indent: 0 },
                    { w: 0.5, indent: 1 },
                    { w: 0.7, indent: 1 },
                    { w: 0.55, indent: 2 },
                    { w: 0.65, indent: 1 },
                    { w: 0.45, indent: 2 },
                    { w: 0.75, indent: 2 },
                  ].map(({ w, indent }, i) => (
                    <div
                      key={i}
                      className="flex items-stretch"
                      style={{ animation: `skeleton-fade 1.5s ease-in-out ${i * 0.15}s infinite` }}
                    >
                      {/* Indent spacers with connector lines */}
                      {Array.from({ length: indent }).map((_, j) => (
                        <div key={j} className="shrink-0 relative" style={{ width: 20 }}>
                          <div style={{
                            position: 'absolute', left: 10, top: 0, bottom: 0,
                            width: 1, background: 'rgba(255, 255, 255, 0.06)',
                          }} />
                        </div>
                      ))}
                      <div
                        className="flex-1 min-w-0 p-3 rounded"
                        style={{
                          background: 'rgba(255, 255, 255, 0.02)',
                          border: '1px solid rgba(255, 255, 255, 0.05)',
                        }}
                      >
                        <div
                          className="rounded"
                          style={{
                            height: 14,
                            width: `${w * 100}%`,
                            background: 'linear-gradient(90deg, rgba(255,255,255,0.06) 25%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.06) 75%)',
                            backgroundSize: '200% 100%',
                            animation: 'skeleton-shimmer 1.8s ease-in-out infinite',
                          }}
                        />
                        <div
                          className="rounded mt-2"
                          style={{
                            height: 10,
                            width: `${w * 60}%`,
                            background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.07) 50%, rgba(255,255,255,0.04) 75%)',
                            backgroundSize: '200% 100%',
                            animation: 'skeleton-shimmer 1.8s ease-in-out infinite',
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-1.5">
                {taskTreeFlat.map(node => (
                  <TaskRow
                    key={node.task.id}
                    task={node.task}
                    allTasks={tasks}
                    treeNode={node}
                    onMarkResolved={markTaskResolved}
                    onRun={runTask}
                    onStop={(taskId) => {
                      const t = tasks.find(t => t.id === taskId)
                      if (t?.assignedAgentId) killAgent(t.assignedAgentId)
                    }}
                    onRemove={removeTask}
                    onShowPrompt={setModalPrompt}
                    onShowDiff={setDiffAgentId}
                    onOpenChat={(agentId) => setChatAgentId(prev => prev === agentId ? null : agentId)}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Actions */}
        <div
          className="flex gap-2 p-3"
          style={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}
        >
          {currentPlan.status === 'draft' && (
            <>
              <button
                onClick={() => generateTasks()}
                className="flex-1 px-4 py-2 text-sm font-medium transition-colors rounded"
                style={{
                  background: 'linear-gradient(to right bottom, rgba(34, 197, 94, 0.15), rgba(74, 222, 128, 0.35))',
                  color: 'rgb(114, 222, 128)',
                  border: '1px solid rgba(34, 197, 94, 0.2)',
                }}
              >
                Generate Tasks
              </button>
              <button
                onClick={cancelPlan}
                className="px-4 py-2 text-sm font-medium transition-colors rounded"
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  color: 'rgba(255, 255, 255, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                }}
              >
                Cancel
              </button>
            </>
          )}
          {currentPlan.status === 'prompts_ready' && (
            <>
              <button
                onClick={() => executePlan()}
                className="flex-1 px-4 py-2 text-sm font-medium transition-colors rounded"
                style={{
                  background: 'linear-gradient(to right bottom, rgba(34, 197, 94, 0.15), rgba(74, 222, 128, 0.35))',
                  color: 'rgb(114, 222, 128)',
                  border: '1px solid rgba(34, 197, 94, 0.2)',
                }}
              >
                Execute Plan
              </button>
              <button
                onClick={cancelPlan}
                className="px-4 py-2 text-sm font-medium transition-colors rounded"
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  color: 'rgba(255, 255, 255, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                }}
              >
                Cancel
              </button>
            </>
          )}
          {currentPlan.status === 'generating_prompts' && (
            <button
              disabled
              className="flex-1 px-4 py-2 text-sm font-medium opacity-50 cursor-not-allowed rounded"
              style={{
                background: 'linear-gradient(to right bottom, rgba(34, 197, 94, 0.15), rgba(74, 222, 128, 0.35))',
                color: 'rgb(114, 222, 128)',
                border: '1px solid rgba(34, 197, 94, 0.2)',
              }}
            >
              {hasTasks
                ? `Generating prompts ${tasks.filter(t => t.prompt).length}/${totalCount}`
                : 'Generating tasks...'}
            </button>
          )}
          {currentPlan.status === 'executing' && (
            <>
              {availableToRun.length > 0 && (
                <button
                  onClick={runAvailableTasks}
                  className="flex-1 px-4 py-2 text-sm font-medium transition-colors rounded"
                  style={{
                    background: 'linear-gradient(to right bottom, rgba(34, 197, 94, 0.15), rgba(74, 222, 128, 0.35))',
                    color: 'rgb(114, 222, 128)',
                    border: '1px solid rgba(34, 197, 94, 0.2)',
                  }}
                >
                  Run Available ({availableToRun.length})
                </button>
              )}
              <button
                onClick={cancelPlan}
                className="px-4 py-2 text-sm font-medium transition-colors rounded"
                style={{
                  background: 'rgba(239, 68, 68, 0.1)',
                  color: 'rgba(239, 68, 68, 0.8)',
                  border: '1px solid rgba(239, 68, 68, 0.2)',
                }}
              >
                Cancel
              </button>
            </>
          )}
          {(currentPlan.status === 'completed' || currentPlan.status === 'failed') && (
            <button
              onClick={cancelPlan}
              className="flex-1 px-4 py-2 text-sm font-medium transition-colors"
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                color: 'rgba(255, 255, 255, 0.6)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }}
            >
              Close
            </button>
          )}
        </div>
      </div>

      {/* Agent chat panel — right side of plan panel */}
      {chatAgentId && (
        <div
          className="fixed"
          data-swarm-ui
          style={{
            left: position.x + 520 + 8,
            top: position.y,
            zIndex: 1003,
            pointerEvents: 'auto',
          }}
        >
          <ChatWindow
            key={chatAgentId}
            lizardId={chatAgentId}
            title={tasks.find(t => t.assignedAgentId === chatAgentId)?.name || 'Agent Chat'}
            onClose={() => setChatAgentId(null)}
          />
        </div>
      )}

      {/* Diff modal */}
      {diffAgentId && (
        <DiffModal
          fileChanges={diffFileChanges}
          onClose={() => setDiffAgentId(null)}
          onRevertFile={(filePath) => revertFiles(diffAgentId, [filePath])}
        />
      )}

      {/* Prompt modal */}
      {modalPrompt && (
        <div
          className="fixed inset-0"
          style={{ zIndex: 10001 }}
          onClick={() => setModalPrompt(null)}
        >
          <div className="absolute inset-0" style={{ background: 'rgba(0, 0, 0, 0.7)' }} />
          <div className="flex items-center justify-center w-full h-full">
            <div
              className="relative overflow-hidden flex flex-col rounded-lg"
              onClick={e => e.stopPropagation()}
              style={{
                width: 700,
                maxWidth: '90vw',
                maxHeight: '80vh',
                background: 'linear-gradient(135deg, rgb(35, 35, 45), rgb(45, 45, 55))',
                backdropFilter: 'blur(12px) saturate(180%)',
                WebkitBackdropFilter: 'blur(12px) saturate(180%)',
                    }}
            >
              {/* Modal header */}
              <div
                className="flex items-center justify-between px-5 py-3 shrink-0"
                style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.1)' }}
              >
                <span className="text-white font-medium text-sm truncate pr-4">
                  {modalPrompt.description}
                </span>
                <button
                  onClick={() => setModalPrompt(null)}
                  className="text-white/60 hover:text-white transition-colors w-6 h-6 flex items-center justify-center hover:bg-white/10 shrink-0 rounded"
                >
                  ✕
                </button>
              </div>
              {/* Modal body */}
              <div
                className="flex-1 overflow-y-auto p-5 text-sm plan-abstract"
                style={{ wordBreak: 'break-word' }}
              >
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    p: ({ children }) => <p className="text-white/70 leading-relaxed mb-3 last:mb-0">{children}</p>,
                    strong: ({ children }) => <strong className="text-white/90 font-semibold">{children}</strong>,
                    ul: ({ children }) => <ul className="text-white/60 list-disc pl-4 mb-3 last:mb-0 space-y-0.5">{children}</ul>,
                    ol: ({ children }) => <ol className="text-white/60 list-decimal pl-4 mb-3 last:mb-0 space-y-0.5">{children}</ol>,
                    li: ({ children }) => <li className="text-white/60 leading-relaxed">{children}</li>,
                    code: ({ children }) => {
                      const text = typeof children === 'string' ? children : String(children ?? '')
                      const isPath = text.includes('/') && !text.includes(' ')
                      const display = isPath ? text.split('/').slice(-2).join('/') : text
                      return <code className="text-[#BFFF6B] text-xs px-1 py-0.5 rounded" title={isPath ? text : undefined} style={{ background: 'rgba(255,255,255,0.06)' }}>{display}</code>
                    },
                    h1: ({ children }) => <h2 className="text-white font-semibold text-base mb-2">{children}</h2>,
                    h2: ({ children }) => <h3 className="text-white font-semibold text-sm mb-2">{children}</h3>,
                    h3: ({ children }) => <h4 className="text-white/90 font-medium text-sm mb-1">{children}</h4>,
                  }}
                >
                  {(() => {
                    const raw = modalPrompt.prompt
                    const stripped = raw.trim().replace(/^```json\s*/m, '').replace(/```\s*$/m, '').trim()
                    try {
                      const obj = JSON.parse(stripped)
                      if (obj.prompt) return obj.prompt
                    } catch { /* not pure JSON */ }
                    const start = raw.indexOf('{')
                    const end = raw.lastIndexOf('}')
                    if (start >= 0 && end > start) {
                      try {
                        const obj = JSON.parse(raw.slice(start, end + 1))
                        if (obj.prompt) return obj.prompt
                      } catch { /* not valid JSON block */ }
                    }
                    return raw
                  })()}
                </Markdown>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
