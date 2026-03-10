import React from 'react'

interface RocketProps {
  className?: string
  style?: React.CSSProperties
}

export const Rocket: React.FC<RocketProps> = ({ className, style }) => {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="flameGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFA500" />
          <stop offset="50%" stopColor="#FF6B00" />
          <stop offset="100%" stopColor="#FF4500" />
        </linearGradient>
        <linearGradient id="flameInnerGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFDD00" />
          <stop offset="100%" stopColor="#FFA500" />
        </linearGradient>
      </defs>

      {/* Rocket body - pointing upward-right at 45 degrees */}
      <g transform="rotate(-45 20 20)">
        {/* Main body */}
        <ellipse cx="20" cy="16" rx="6" ry="12" fill="#E8E8E8" />

        {/* Nose cone */}
        <path
          d="M20 4 L14 12 L26 12 Z"
          fill="#D0D0D0"
        />

        {/* Window */}
        <circle cx="20" cy="14" r="3" fill="#4A90D9" />
        <circle cx="20" cy="14" r="2" fill="#6BB3F0" />

        {/* Left fin */}
        <path
          d="M14 22 L10 30 L14 28 Z"
          fill="#C0C0C0"
        />

        {/* Right fin */}
        <path
          d="M26 22 L30 30 L26 28 Z"
          fill="#C0C0C0"
        />

        {/* Flame outer */}
        <path
          d="M16 28 L20 38 L24 28 Q20 32 16 28"
          fill="url(#flameGradient)"
        />

        {/* Flame inner */}
        <path
          d="M18 28 L20 34 L22 28 Q20 30 18 28"
          fill="url(#flameInnerGradient)"
        />
      </g>
    </svg>
  )
}
