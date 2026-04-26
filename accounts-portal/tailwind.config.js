/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'linear-bg': '#0D0E11',
        'linear-surface': '#1C1D22',
        'linear-purple': '#5E6AD2',
        'linear-purple-hover': '#7C3AED',
        'linear-text': '#FAFAFA',
        'linear-text-secondary': '#A1A1AA',
        'linear-success': '#30A46C',
        'linear-error': '#E5484D',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      letterSpacing: {
        tighter: '-0.01em',
      },
    },
  },
  plugins: [],
}
