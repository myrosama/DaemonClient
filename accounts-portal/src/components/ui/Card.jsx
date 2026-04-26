import React from 'react'

export function Card({ children, hover = false, className = '' }) {
  const baseStyles = 'bg-linear-surface border border-white/[0.06] rounded-md backdrop-blur-xl'
  const hoverStyles = hover ? 'transition-transform duration-150 ease-out hover:-translate-y-0.5' : ''

  return (
    <div className={`${baseStyles} ${hoverStyles} ${className}`}>
      {children}
    </div>
  )
}
