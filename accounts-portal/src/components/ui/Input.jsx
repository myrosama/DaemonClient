import React from 'react'

export function Input({
  type = 'text',
  value,
  onChange,
  placeholder,
  required = false,
  error = false,
  className = ''
}) {
  const baseStyles = 'h-12 px-4 bg-[#27272A] border rounded-md text-[15px] text-linear-text placeholder:text-white/25 focus:outline-none focus:ring-1 transition-colors duration-150'
  const borderStyles = error
    ? 'border-linear-error focus:border-linear-error focus:ring-linear-error'
    : 'border-white/[0.1] focus:border-daemon-green/50 focus:ring-daemon-green/20'

  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      required={required}
      className={`${baseStyles} ${borderStyles} ${className}`}
    />
  )
}
