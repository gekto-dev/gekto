export default function App() {
  return (
    <main className="app">
      <h1 className="shimmer">Gekto Demo</h1>
      <p className="subtitle">Coming soon</p>
      <ul className="feature-list">
        <li className="feature-item">
          <span className="feature-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </span>
          <span className="feature-label">Todo app</span>
          <span className="feature-status">Soon</span>
        </li>
        <li className="feature-item">
          <span className="feature-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <path d="M9 21V12h6v9" />
            </svg>
          </span>
          <span className="feature-label">Landing page</span>
          <span className="feature-status">Soon</span>
        </li>
        <li className="feature-item">
          <span className="feature-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M8 13h8" />
              <path d="M8 17h6" />
            </svg>
          </span>
          <span className="feature-label">Blog page</span>
          <span className="feature-status">Soon</span>
        </li>
      </ul>
    </main>
  );
}
