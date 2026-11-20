# gir_v7 — photography portfolio

Static [Astro](https://astro.build) site with content from [Sanity](https://www.sanity.io), deployed on Netlify.

```
src/
  components/        SanityImage (responsive <img> via Sanity CDN), ExhibitionList
  layouts/Layout.astro
  lib/markdown.ts    Markdown → HTML + plain-text excerpt (meta descriptions)
  lib/sanity/        fetch helpers, GROQ queries, image URL builder, result types
  pages/             /, /work, /about, /galleries/[slug], 404
studio/              Sanity Studio (schemas in studio/schemaTypes)
```

## Setup

```sh
cp .env.example .env            # fill PUBLIC_SANITY_PROJECT_ID (+ optional PRIVATE_SANITY_READ_TOKEN)
pnpm install
pnpm dev                        # http://localhost:4321
```

Studio:

```sh
cd studio
cp .env.example .env
pnpm install
pnpm dev                        # http://localhost:3333
```

## Commands

| Command        | Action                                     |
| :------------- | :----------------------------------------- |
| `pnpm dev`     | Dev server (Sanity errors only warn)       |
| `pnpm build`   | Static build to `dist/` — **fails** if Sanity can't be reached, so an empty site is never deployed |
| `pnpm preview` | Serve the built site                       |
| `pnpm check`   | Type-check `.astro` / `.ts` files          |

## Notes

- **Images** are resized by the Sanity CDN (`srcset` up to the original width); no build-time image processing.
- **Fonts**: Jost is downloaded at build time by Astro's Fonts API and self-hosted under `/_astro/fonts/`.
- **Query result types** live in `src/lib/sanity/types.ts` — keep them in sync with `studio/schemaTypes` when adding fields.
- **Deploys**: a Sanity webhook can trigger a Netlify build hook on publish (see `.env.example`).
