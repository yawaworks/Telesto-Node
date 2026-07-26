/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,jsx}",
    "./components/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        "hud-cyan": "#22d3ee",
        "hud-red": "#f87171",
      },
    },
  },
  plugins: [],
};
