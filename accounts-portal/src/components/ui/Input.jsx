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
  const baseStyles = 'h-8 px-3 bg-[#27272A] border rounded-md text-sm text-linear-text placeholder:text-gray-500 focus:outline-none focus:ring-1 transition-colors duration-150'
  const borderStyles = error
    ? 'border-linear-error focus:border-linear-error focus:ring-linear-error'
    : 'border-white/10 focus:border-violet-500 focus:ring-violet-500'

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
