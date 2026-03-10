import { ReactNode } from 'react'

interface LayoutProps {
  sidebar: ReactNode
  rightPanel: ReactNode
  children: ReactNode
}

export function Layout({ sidebar, rightPanel, children }: LayoutProps) {
  return (
    <div className="layout-grid">
      {/* Animated glow orbs */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(ellipse at 30% 50%, rgba(34, 197, 94, 0.06) 0%, transparent 60%), radial-gradient(ellipse at 70% 50%, rgba(134, 239, 172, 0.04) 0%, transparent 50%)',
          animation: 'bg-drift 12s ease-in-out infinite',
          pointerEvents: 'none',
        }}
      />
      {/* Subtle grid overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
          pointerEvents: 'none',
        }}
      />

      {/* Left Sidebar */}
      <aside className="sidebar-slot">
        {sidebar}
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <div className="main-content-inner">
          {children}
        </div>
      </main>

      {/* Right Panel */}
      <aside className="right-panel-slot">
        {rightPanel || <div />}
      </aside>
    </div>
  )
}
