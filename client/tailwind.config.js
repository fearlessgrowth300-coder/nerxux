/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Nexus AI brand palette
        nexus: {
          bg: '#0b0f17',
          panel: '#121826',
          border: '#1f2937',
          accent: '#6366f1',
          accent2: '#22d3ee',
        },
      },
    },
  },
  plugins: [],
}
