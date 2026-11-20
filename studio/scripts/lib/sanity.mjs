/** Helpers shared by the Studio maintenance scripts (import, migrations). */

import { createClient } from "@sanity/client";
import { createHash } from "node:crypto";
import path from "node:path";

export const draftId = (id) => `drafts.${id}`;
export const publishedId = (id) => id.replace(/^drafts\./, "");
export const stemOf = (file) => path.basename(file, path.extname(file));
export const shortHash = (...parts) =>
  createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 20);

/**
 * Document ids must not contain dots: Sanity treats `a.b` ids as private, so the public API
 * (and a site without a read token) can't see them. Older imports used `importGallery.<slug>`
 * and `importPhoto.<slug>.<hash>`; `migrate-legacy-ids.mjs` moves those to the ids below.
 */
export const galleryIdFor = (slug) => `gallery-${slug}`;
export const photoIdFor = (slug, stem) => `photo-${shortHash(slug, stem.toLowerCase())}`;

export function stripSystemFields(doc) {
  const { _rev, _createdAt, _updatedAt, _originalId, ...rest } = doc;
  return rest;
}

/** Write client from studio/.env. Returns null when credentials are missing and not `required`. */
export function makeClient(dataset, { required }) {
  const projectId = process.env.SANITY_STUDIO_PROJECT_ID || process.env.SANITY_PROJECT_ID;
  const token =
    process.env.SANITY_API_WRITE_TOKEN || process.env.SANITY_API_TOKEN || process.env.SANITY_TOKEN;

  if (!projectId || !token) {
    if (!required) return null;
    console.error(
      `Missing ${!projectId ? "SANITY_STUDIO_PROJECT_ID" : "SANITY_API_WRITE_TOKEN"} (set it in studio/.env).`,
    );
    process.exit(1);
  }

  return createClient({
    projectId,
    dataset,
    token,
    apiVersion: "2025-02-19",
    useCdn: false,
    // See drafts and published documents alike.
    perspective: "raw",
  });
}

export function resolveDataset(override) {
  return override || process.env.SANITY_STUDIO_DATASET || process.env.SANITY_DATASET || "production";
}
