import { useState, useRef } from 'react'
import { ChatBubbleIcon, ChevronDownIcon, ChevronUpIcon } from '@radix-ui/react-icons'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useGekto, usePlanTasks, type Task } from '../context/GektoContext'
import { useAgent } from '../context/AgentContext'

interface GektoPlanPanelProps {
  position: { x: number; y: number }
  height?: number
  onClose: () => void
}



interface TaskRowProps {
  task: Task
  onMarkResolved?: (taskId: string) => void
  onRun?: (taskId: string) => void
  onStop?: (taskId: string) => void
  onRemove?: (taskId: string) => void
  onShowPrompt?: (task: Task) => void
}

function TaskRow({ task, onMarkResolved, onRun, onStop, onRemove, onShowPrompt }: TaskRowProps) {
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)

  const handleMarkResolved = () => {
    setIsRemoving(true)
    // Wait for animation to complete before actually removing
    setTimeout(() => {
      onMarkResolved?.(task.id)
    }, 300)
  }

  const getBackgroundStyle = () => {
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

  // Split description into lines and check if truncation needed
  const descriptionLines = task.description.split('\n')
  const needsTruncation = descriptionLines.length > 2
  const truncatedDescription = needsTruncation && !isDescriptionExpanded
    ? descriptionLines.slice(0, 2).join('\n') + '...'
    : task.description

  return (
    <div
      className={`flex items-start gap-3 p-3 transition-all duration-300 rounded${task.status === 'in_progress' ? ' task-shimmer' : ''}`}
      style={{
        ...( task.status !== 'in_progress' ? { background: style.bg } : {}),
        border: style.border,
        opacity: isRemoving ? 0 : 1,
        transform: isRemoving ? 'translateX(20px) scale(0.95)' : 'translateX(0) scale(1)',
        maxHeight: isRemoving ? 0 : 500,
        marginBottom: isRemoving ? 0 : undefined,
        padding: isRemoving ? 0 : undefined,
        overflow: 'hidden',
      }}
    >
      <div className="flex-1 min-w-0 relative">
        {/* Play/Pause & Remove buttons — top right corner */}
        {!isRemoving && (
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
                disabled={task.status === 'completed' || task.status === 'pending_testing' || !task.prompt}
                className="w-6 h-6 flex items-center justify-center transition-all text-white/40 hover:text-white pl-px cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed"
                title="Run task"
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

        {/* Description - truncated to 2 lines, expandable */}
        <div className="mb-1">
          <div
            className="text-white text-sm font-medium whitespace-pre-wrap pr-14"
            style={{ wordBreak: 'break-word' }}
          >
            {truncatedDescription}
          </div>
          {needsTruncation && (
            <button
              onClick={() => setIsDescriptionExpanded(!isDescriptionExpanded)}
              className="flex items-center gap-1 mt-1 text-xs text-white/50 hover:text-white/70 transition-colors"
            >
              {isDescriptionExpanded ? (
                <>
                  <ChevronUpIcon width={12} height={12} />
                  <span>Show less</span>
                </>
              ) : (
                <>
                  <ChevronDownIcon width={12} height={12} />
                  <span>Show more</span>
                </>
              )}
            </button>
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
              <ChatBubbleIcon width={12} height={12} />
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
              <ChatBubbleIcon width={12} height={12} />
            </button>
          )}
          {task.status === 'pending_testing' && !isRemoving && (
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
  )
}

export function GektoPlanPanel({ position, height, onClose }: GektoPlanPanelProps) {
  const [modalPrompt, setModalPrompt] = useState<Task | null>(null)
  const { currentPlan, generateTasks, executePlan, buildPlan, cancelPlan, markTaskResolved, runTask, removeTask } = useGekto()
  const tasks = usePlanTasks()
  const { killAgent } = useAgent()

  // Collapsible sections — abstract open by default in draft, tasks open when generated
  const hasTasks = tasks.length > 0
  const isDraft = currentPlan?.status === 'draft'
  const isGeneratingTasks = currentPlan?.status === 'generating_prompts'
  const isPlanning = currentPlan?.status === 'planning'
  const [abstractOpen, setAbstractOpen] = useState(true)
  const [tasksOpen, setTasksOpen] = useState(false)

  // Auto-toggle sections when tasks are generated
  const prevHasTasks = useRef(hasTasks)
  if (hasTasks && !prevHasTasks.current) {
    // Tasks just appeared — collapse abstract, expand tasks
    setAbstractOpen(false)
    setTasksOpen(true)
  }
  prevHasTasks.current = hasTasks

  // Fold abstract when generating tasks starts
  const prevGenerating = useRef(isGeneratingTasks)
  if (isGeneratingTasks && !prevGenerating.current) {
    setAbstractOpen(false)
    setTasksOpen(true)
  }
  prevGenerating.current = isGeneratingTasks

  if (!currentPlan) return null

  const completedCount = tasks.filter(t => t.status === 'completed').length
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

        {/* Scrollable content */}
        <div className="flex-1 p-3 space-y-2 overflow-y-auto min-h-0">

          {/* Planning spinner */}
          {currentPlan.status === 'planning' && (
            <div className="flex items-center justify-center py-8">
              <div className="text-white/60 text-sm">
                <span className="inline-flex gap-1">
                  <span className="animate-bounce">.</span>
                  <span className="animate-bounce" style={{ animationDelay: '0.1s' }}>.</span>
                  <span className="animate-bounce" style={{ animationDelay: '0.2s' }}>.</span>
                </span>
                <span className="ml-2">Analyzing and writing plan</span>
              </div>
            </div>
          )}

          {/* Abstract section — collapsible accordion */}
          {currentPlan.abstract && (
            <div className={isPlanning ? 'section-updating' : ''} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}>
              <button
                onClick={() => setAbstractOpen(!abstractOpen)}
                className="flex items-center justify-between w-full text-left px-1 py-3 text-sm font-semibold text-white/70 hover:text-white transition-colors"
              >
                <span>Abstract</span>
                {abstractOpen ? <ChevronUpIcon width={14} height={14} /> : <ChevronDownIcon width={14} height={14} />}
              </button>
              {abstractOpen && (
                <div className="px-1 pb-3 text-sm plan-abstract">
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
            </div>
          )}

          {/* Execution progress bar */}
          {currentPlan.status === 'executing' && (
            <div className="px-1 py-1">
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

          {/* Tasks section — collapsible accordion */}
            <div className={isGeneratingTasks ? 'section-updating' : ''} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}>
              <button
                onClick={() => (hasTasks || isGeneratingTasks) && setTasksOpen(!tasksOpen)}
                className={`flex items-center justify-between w-full text-left px-1 py-3 text-sm font-semibold transition-colors ${hasTasks || isGeneratingTasks ? 'text-white/70 hover:text-white cursor-pointer' : 'text-white/30 cursor-default'}`}
              >
                <span>Tasks {totalCount > 0 && <span className="text-white/40 font-normal">{totalCount}</span>}</span>
                {(hasTasks || isGeneratingTasks) && (tasksOpen ? <ChevronUpIcon width={14} height={14} /> : <ChevronDownIcon width={14} height={14} />)}
              </button>
              {tasksOpen && (hasTasks || isGeneratingTasks) && (
                <div className="space-y-2 pb-3">
                  {isGeneratingTasks && !hasTasks && (
                    <div className="flex items-center gap-2 px-1 py-2 text-xs text-white/50">
                      <span className="inline-flex gap-0.5">
                        <span className="animate-bounce">.</span>
                        <span className="animate-bounce" style={{ animationDelay: '0.1s' }}>.</span>
                        <span className="animate-bounce" style={{ animationDelay: '0.2s' }}>.</span>
                      </span>
                      <span>Generating tasks from abstract</span>
                    </div>
                  )}
                  {tasks.map(task => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onMarkResolved={markTaskResolved}
                      onRun={runTask}
                      onStop={(taskId) => {
                        const t = tasks.find(t => t.id === taskId)
                        if (t?.assignedAgentId) killAgent(t.assignedAgentId)
                      }}
                      onRemove={removeTask}
                      onShowPrompt={setModalPrompt}
                    />
                  ))}
                </div>
              )}
            </div>
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
              Generating Tasks...
            </button>
          )}
          {currentPlan.status === 'executing' && (
            <button
              onClick={cancelPlan}
              className="flex-1 px-4 py-2 text-sm font-medium transition-colors rounded"
              style={{
                background: 'rgba(239, 68, 68, 0.1)',
                color: 'rgba(239, 68, 68, 0.8)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
              }}
            >
              Cancel Execution
            </button>
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
                className="flex-1 overflow-y-auto p-5 text-xs text-white/80 whitespace-pre-wrap"
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                  wordBreak: 'break-word',
                }}
              >
                {modalPrompt.prompt}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
