#!/usr/bin/env node
/**
 * Batch-import photo galleries from a directory layout:
 *
 *   <root>/
 *     My Gallery Title/
 *       a.jpg
 *       b.jpeg
 *     Another Gallery/
 *       ...
 *
 * Each immediate subfolder becomes one gallery (title = folder name).
 * All .jpg / .jpeg files in that folder (non-recursive) become photo documents
 * and are wired to the gallery in alphabetical order.
 *
 * Requirements:
 *   - SANITY_API_WRITE_TOKEN (or SANITY_API_TOKEN) with write access
 *   - SANITY_STUDIO_PROJECT_ID (or SANITY_PROJECT_ID)
 *   - SANITY_STUDIO_DATASET (optional, default: production)
 *
 * Writes each document as a draft under drafts.<id>, then publishes so the public
 * API (and the site without a read token) can see galleries and photos.
 *
 * Optional: load env from a file (Node 22+):
 *   node --env-file=.env scripts/import-galleries.mjs <rootDir>
 *
 * Flags:
 *   --dry-run    List actions without calling the API
 *   --skip-existing   Skip folders whose slug already exists on a gallery
 */

import { createClient } from "@sanity/client";
import { createHash } from "node:crypto";
import {
  readdir,
  stat,
  readFile,
} from "node:fs/promises";
import path from "node:path";

const IMAGE_EXT = new Set([".jpg", ".jpeg"]);

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const a of argv) {
    if (a === "--dry-run" || a === "--skip-existing") flags.add(a);
    else if (!a.startsWith("-")) positional.push(a);
  }
  return { flags, positional };
}

function slugify(title) {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
}

function stablePhotoId(gallerySlug, basename) {
  const h = createHash("sha256")
    .update(`${gallerySlug}\0${basename}`)
    .digest("hex")
    .slice(0, 24);
  return `importPhoto.${gallerySlug.slice(0, 40)}.${h}`;
}

function stableGalleryId(slug) {
  return `importGallery.${slug}`;
}

/** Draft document id for Sanity’s publish workflow (mutations-only creates are not public). */
function toDraftId(publishedId) {
  return publishedId.startsWith("drafts.") ? publishedId : `drafts.${publishedId}`;
}

async function publishDocument(client, publishedId) {
  await client.action({
    actionType: "sanity.action.document.publish",
    publishedId,
    // Content Lake expects `versionId` (drafts.* or versions.*); `draftId` is deprecated.
    versionId: toDraftId(publishedId),
  });
}

async function listJpegs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    files.push(path.join(dir, e.name));
  }
  files.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return files;
}

async function gallerySlugExists(client, slug) {
  const q = `count(*[_type == "gallery" && slug.current == $slug]) > 0`;
  return client.fetch(q, { slug });
}

function makeClient() {
  const projectId =
    process.env.SANITY_STUDIO_PROJECT_ID || process.env.SANITY_PROJECT_ID;
  const dataset =
    process.env.SANITY_STUDIO_DATASET || process.env.SANITY_DATASET || "production";
  const token =
    process.env.SANITY_API_WRITE_TOKEN ||
    process.env.SANITY_API_TOKEN ||
    process.env.SANITY_TOKEN;

  if (!projectId) {
    console.error("Missing SANITY_STUDIO_PROJECT_ID (or SANITY_PROJECT_ID).");
    process.exit(1);
  }
  if (!token) {
    console.error(
      "Missing SANITY_API_WRITE_TOKEN (or SANITY_API_TOKEN / SANITY_TOKEN)."
    );
    process.exit(1);
  }

  return createClient({
    projectId,
    dataset,
    token,
    apiVersion: "2025-02-19",
    useCdn: false,
  });
}

async function importOneGallery(client, folderPath, options) {
  const title = path.basename(folderPath);
  const slug = slugify(title);
  if (!slug) {
    console.warn(`Skip (empty slug after slugify): ${folderPath}`);
    return;
  }

  const jpegPaths = await listJpegs(folderPath);
  if (jpegPaths.length === 0) {
    console.warn(`Skip (no JPEGs): ${folderPath}`);
    return;
  }

  if (
    options.skipExisting &&
    client &&
    (await gallerySlugExists(client, slug))
  ) {
    console.log(`Skip (gallery slug exists): ${title} [${slug}]`);
    return;
  }

  if (options.dryRun) {
    console.log(`[dry-run] Gallery "${title}" (${slug}) — ${jpegPaths.length} image(s)`);
    for (const p of jpegPaths) console.log(`    ${path.basename(p)}`);
    return;
  }

  const galleryId = stableGalleryId(slug);

  const photoRefs = [];

  for (let i = 0; i < jpegPaths.length; i++) {
    const filePath = jpegPaths[i];
    const basename = path.basename(filePath);
    const buffer = await readFile(filePath);
    const asset = await client.assets.upload("image", buffer, {
      filename: basename,
    });

    const photoId = stablePhotoId(slug, basename);
    const titleFromFile = path.basename(basename, path.extname(basename));

    await client.createOrReplace({
      _id: toDraftId(photoId),
      _type: "photo",
      title: titleFromFile,
      image: {
        _type: "image",
        asset: {
          _type: "reference",
          _ref: asset._id,
        },
      },
    });
    await publishDocument(client, photoId);

    photoRefs.push({
      _type: "reference",
      _ref: photoId,
      _key: `p${i}-${photoId.slice(-8)}`,
    });
  }

  await client.createOrReplace({
    _id: toDraftId(galleryId),
    _type: "gallery",
    title,
    slug: { _type: "slug", current: slug },
    priority: 0,
    photos: photoRefs,
  });
  await publishDocument(client, galleryId);

  console.log(`Imported: "${title}" (${slug}) — ${jpegPaths.length} photo(s)`);
}

function printUsage() {
  console.error(`Usage: node scripts/import-galleries.mjs <rootDir> [options]

  rootDir     Parent folder; each direct subfolder is one gallery (title = folder name).

  Options:
    --dry-run          Print planned imports only (no API calls unless --skip-existing).
    --skip-existing    Skip subfolders whose gallery slug already exists in the dataset.
`);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const dryRun = flags.has("--dry-run");
  const skipExisting = flags.has("--skip-existing");

  if (positional.length === 0) {
    printUsage();
    process.exit(1);
  }

  const rootDir = path.resolve(positional[0]);

  let st;
  try {
    st = await stat(rootDir);
  } catch {
    console.error(`Not a directory: ${rootDir}`);
    process.exit(1);
  }
  if (!st.isDirectory()) {
    console.error(`Not a directory: ${rootDir}`);
    process.exit(1);
  }

  const needClient = !dryRun || skipExisting;
  const client = needClient ? makeClient() : null;

  const entries = await readdir(rootDir, { withFileTypes: true });
  const subdirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(rootDir, e.name))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  if (subdirs.length === 0) {
    console.warn(`No subfolders under ${rootDir}`);
    process.exit(0);
  }

  console.log(
    dryRun
      ? `Dry run — ${subdirs.length} folder(s) under ${rootDir}`
      : `Importing ${subdirs.length} folder(s) from ${rootDir}`
  );

  const options = { dryRun, skipExisting };

  for (const dir of subdirs) {
    try {
      await importOneGallery(client, dir, options);
    } catch (err) {
      console.error(`Failed: ${dir}`, err.message || err);
      process.exitCode = 1;
    }
  }
}

main();
