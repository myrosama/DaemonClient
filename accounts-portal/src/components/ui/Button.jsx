import React from 'react'

export function Button({
  children,
  variant = 'primary',
  disabled = false,
  type = 'button',
  onClick,
  className = ''
}) {
  const baseStyles = 'h-8 px-4 rounded-md text-sm font-medium transition-all duration-150 ease-out disabled:opacity-50 disabled:cursor-not-allowed'

  const variants = {
    primary: 'bg-linear-purple hover:bg-linear-purple-hover text-white',
    ghost: 'bg-transparent hover:bg-white/5 text-linear-text',
    outline: 'bg-transparent border border-white/10 hover:border-white/20 text-linear-text',
    danger: 'bg-linear-error hover:bg-red-600 text-white'
  }

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${baseStyles} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  )
}
