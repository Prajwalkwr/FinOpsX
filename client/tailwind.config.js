/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: 'var(--bg)',
        card: 'var(--card)',
        ink: 'var(--text)',
        muted: 'var(--muted)',
        line: 'var(--border)',
        brand: '#2f6bff',
        panel: '#101a33',
        navy: {
          800: '#152033',
          900: '#10192a',
          950: '#0b1220',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Suisse Intl', 'Suisse', 'system-ui', 'sans-serif'],
        display: ['"Passion One"', 'Arial Black', 'sans-serif'],
      },
      boxShadow: {
        card: '0 8px 24px rgba(27, 36, 55, 0.04)',
      },
    },
  },
  plugins: [],
}
