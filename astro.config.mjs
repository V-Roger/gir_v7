// @ts-check
import sanity from "@sanity/astro";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { loadEnv } from "vite";

// Node does not load .env for this file; mirror Vite/Astro env resolution for integrations.
const mode = process.env.NODE_ENV ?? "development";
Object.assign(process.env, loadEnv(mode, process.cwd(), ""));

// https://astro.build/config
export default defineConfig({
  integrations: [
    sanity({
      projectId: process.env.PUBLIC_SANITY_PROJECT_ID || "placeholder00",
      dataset: process.env.PUBLIC_SANITY_DATASET || "production",
      useCdn: false,
      apiVersion: "2024-01-01",
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});