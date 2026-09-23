import defaultTheme from "tailwindcss/defaultTheme";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", ...defaultTheme.fontFamily.sans],
        serif: ["Lora", ...defaultTheme.fontFamily.serif],
        mono: ["JetBrains Mono", ...defaultTheme.fontFamily.mono],
      },
      // Theme colours live in CSS variables (global.css) so light/dark swap in one place.
      colors: {
        bg: "var(--bg)",
        "bg-2": "var(--bg-2)",
        line: "var(--line)",
        "line-2": "var(--line-2)",
        body: "var(--text)",
        muted: "var(--text-2)",
        head: "var(--head)",
        accent: "var(--accent)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
