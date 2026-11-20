// @ts-check
import sanity from "@sanity/astro";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders } from "astro/config";
import { loadEnv } from "vite";

// Node does not load .env for this file; mirror Vite/Astro env resolution for integrations.
const mode = process.env.NODE_ENV ?? "development";
Object.assign(process.env, loadEnv(mode, process.cwd(), ""));

// https://astro.build/config
export default defineConfig({
  // Self-hosted at build time: no render-blocking request to Google Fonts.
  fonts: [
    {
      provider: fontProviders.google(),
      name: "Jost",
      cssVariable: "--font-jost",
      weights: ["400 700"],
      styles: ["normal"],
      subsets: ["latin"],
      fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"],
    },
  ],
  integrations: [
    sanity({
      projectId: process.env.PUBLIC_SANITY_PROJECT_ID || "placeholder00",
      dataset: process.env.PUBLIC_SANITY_DATASET || "production",
      useCdn: false,
      apiVersion: "2024-01-01",
      // Only published content. Without this, a token makes the API also return drafts
      // (the "raw" default before API v2025-02-19), so unpublished galleries would go live.
      perspective: "published",
      // Viewer token: see PRIVATE_SANITY_READ_TOKEN in .env.example.
      ...(process.env.PRIVATE_SANITY_READ_TOKEN
        ? { token: process.env.PRIVATE_SANITY_READ_TOKEN }
        : {}),
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    build: {
      // Keep vendor prefixes Safari 16.4–17 still needs (e.g. -webkit-backdrop-filter for the
      // header blur); Vite 8's CSS minifier drops them with its default targets.
      cssTarget: ["chrome111", "edge111", "firefox114", "safari16.4", "ios16.4"],
    },
  },
});
