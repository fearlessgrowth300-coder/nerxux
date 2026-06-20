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
          // Accent colors are CSS variables so the theme can be changed live.
          accent: 'rgb(var(--nexus-accent) / <alpha-value>)',
          accent2: 'rgb(var(--nexus-accent2) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
}
