/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html"],
  theme: {
    extend: {
      colors: {
        zinc: {
          950: '#09090b',
        },
        cyan: {
          600: '#0891b2',
        }
      }
    },
  },
  plugins: [],
}