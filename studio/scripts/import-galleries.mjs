#!/usr/bin/env node
/**
 * Import photo galleries from folders into Sanity.
 *
 *   pnpm import-galleries -- <folder> [options]
 *
 * <folder> is either ONE gallery folder (it directly contains images or a gallery.md),
 * or a parent folder whose direct subfolders are galleries.
 *
 *   Égypte 2016/
 *     gallery.md        optional, see below
 *     IMG_0412.jpg      .jpg .jpeg .png .webp .tif .tiff
 *     IMG_0388.jpg
 *
 * gallery.md (every field optional; the text after the front matter is the Markdown description):
 *
 *   ---
 *   title: Égypte 2016      # default: folder name
 *   slug: egypte-2016       # default: derived from the title
 *   priority: 3             # position on /work, lower first (new galleries default to 0)
 *   order:                  # photo order; unlisted images follow alphabetically
 *     - IMG_0412.jpg
 *   ---
 *   Description in **Markdown**…
 *
 * Behaviour
 *   - A gallery that already exists (matched by slug, whatever its document id) is MERGED:
 *     only images not already in it are added, and title/description/priority from gallery.md
 *     only fill fields that are empty. Nothing you edited in Studio is overwritten.
 *     --replace overwrites those fields and sets the photo list to exactly the folder's images.
 *   - Galleries are saved as DRAFTS to review in Studio; --publish makes them live immediately.
 *     Photo documents are published right away: they only appear on the site through a
 *     published gallery, so publishing the gallery is the single step that makes it live.
 *   - Images are downscaled to --max-size px on the long edge and re-encoded before upload, so
 *     full-resolution originals never reach the public CDN (re-encoding also drops EXIF/GPS).
 *   - Photo title, alt text and caption are read from metadata embedded in the files
 *     (XMP/IPTC as written by Lightroom, Capture One, Bridge…); the title falls back to the filename.
 *
 * Options
 *   --dry-run          Show what would happen. Reads the dataset (if credentials are set) but
 *                      uploads and writes nothing.
 *   --publish          Publish galleries immediately instead of leaving drafts.
 *   --replace          Overwrite title/description/priority from the folder, set the photo list
 *                      to exactly the folder's images and re-upload them.
 *   --skip-existing    Leave galleries that already exist untouched.
 *   --max-size <px>    Long edge of uploaded images (default 2500). 0 uploads the original files.
 *   --dataset <name>   Target dataset (default: SANITY_STUDIO_DATASET, else "production").
 *
 * Environment (studio/.env): SANITY_STUDIO_PROJECT_ID, SANITY_API_WRITE_TOKEN (Editor token),
 * optional SANITY_STUDIO_DATASET.
 */

import exifr from "exifr";
import { randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { parse as parseYaml } from "yaml";
import {
  IMPORT_SOURCE,
  draftId,
  galleryIdFor,
  makeClient,
  photoIdFor,
  publishedId,
  resolveDataset,
  shortHash,
  stemOf,
  stripSystemFields,
} from "./lib/sanity.mjs";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"]);
const SIDECAR = "gallery.md";
const DEFAULT_MAX_SIZE = 2500;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------------------------
// CLI

const USAGE = `Usage: pnpm import-galleries -- <folder> [options]

  <folder>            A gallery folder, or a folder of gallery folders.

  --dry-run           Show the plan; upload and write nothing.
  --publish           Publish galleries now (default: save drafts to review in Studio).
  --replace           Overwrite existing galleries from the folder instead of merging.
  --skip-existing     Don't touch galleries that already exist.
  --max-size <px>     Long edge of uploaded images (default ${DEFAULT_MAX_SIZE}; 0 = originals).
  --dataset <name>    Target dataset (default SANITY_STUDIO_DATASET or "production").

See the header of scripts/import-galleries.mjs for gallery.md and details.`;

function fail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    folder: undefined,
    dryRun: false,
    publish: false,
    replace: false,
    skipExisting: false,
    maxSize: DEFAULT_MAX_SIZE,
    dataset: undefined,
  };
  const valueOf = (flag, i) => {
    const value = argv[i];
    if (value === undefined || value.startsWith("--")) fail(`${flag} needs a value.`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith("--") ? arg.split(/=(.*)/s) : [arg];
    switch (flag) {
      case "--":
        break; // separator forwarded by some package managers
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--publish":
        opts.publish = true;
        break;
      case "--replace":
        opts.replace = true;
        break;
      case "--skip-existing":
        opts.skipExisting = true;
        break;
      case "--max-size":
        opts.maxSize = Number(inline ?? valueOf(flag, ++i));
        break;
      case "--dataset":
        opts.dataset = inline ?? valueOf(flag, ++i);
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) fail(`Unknown option: ${arg}`);
        if (opts.folder) fail(`Only one folder can be given (got "${opts.folder}" and "${arg}").`);
        opts.folder = arg;
    }
  }

  if (!opts.folder) fail("Missing <folder>.");
  if (!Number.isInteger(opts.maxSize) || opts.maxSize < 0) fail("--max-size must be a whole number ≥ 0.");
  if (opts.replace && opts.skipExisting) fail("--replace and --skip-existing can't be combined.");
  return opts;
}

// ---------------------------------------------------------------------------------------------
// Sanity

const GALLERY_BY_SLUG_QUERY = `*[_type == "gallery" && slug.current == $slug && !(_id in path("versions.**"))]{
  ...,
  "photoFiles": photos[]->image.asset->originalFilename
}`;

/** The existing gallery for a slug (draft and/or published), or null. Throws on duplicates. */
async function findGallery(client, slug) {
  const docs = await client.fetch(GALLERY_BY_SLUG_QUERY, { slug });
  if (docs.length === 0) return null;

  const ids = [...new Set(docs.map((d) => publishedId(d._id)))];
  if (ids.length > 1) {
    throw new Error(
      `Several galleries use the slug "${slug}" (${ids.join(", ")}). Merge or rename them in Studio first.`,
    );
  }
  const draft = docs.find((d) => d._id.startsWith("drafts.")) ?? null;
  const published = docs.find((d) => !d._id.startsWith("drafts.")) ?? null;
  const current = draft ?? published;
  const stems = new Set(
    (current.photoFiles ?? []).filter(Boolean).map((file) => stemOf(file).toLowerCase()),
  );
  const refIds = new Set((current.photos ?? []).map((ref) => publishedId(ref._ref)));
  return { id: ids[0], draft, published, current, stems, refIds };
}

/**
 * Is this image already in the gallery? Matches the photo id this script would use, or the
 * uploaded file name (covers photos added in Studio or by older imports). The id check matters
 * because Sanity reuses identical uploads, and the asset then keeps the *first* file name.
 */
function isInGallery(gallery, slug, file) {
  const stem = stemOf(file).toLowerCase();
  return gallery.refIds.has(photoIdFor(slug, stem)) || gallery.stems.has(stem);
}

/** A free id for a new gallery: `gallery-<slug>`, with a suffix if that id is taken. */
async function newGalleryId(client, slug) {
  const base = galleryIdFor(slug);
  if (!client) return base;
  const taken = await client.fetch(`count(*[_id in $ids]) > 0`, { ids: [base, draftId(base)] });
  return taken ? `${base}-${randomBytes(3).toString("hex")}` : base;
}

// ---------------------------------------------------------------------------------------------
// Folders, gallery.md, ordering

const isImage = (name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

function slugify(title) {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96)
    .replace(/-$/, "");
}

/** Parse gallery.md: YAML front matter (title, slug, priority, order) + Markdown description. */
async function readSidecar(dir, warn) {
  let text;
  try {
    text = await readFile(path.join(dir, SIDECAR), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  text = text.replace(/^﻿/, "");

  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  let data = {};
  if (match) {
    try {
      data = parseYaml(match[1]) ?? {};
    } catch (err) {
      throw new Error(`${SIDECAR}: invalid front matter — ${err.message}`, { cause: err });
    }
    if (typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`${SIDECAR}: front matter must be "key: value" lines.`);
    }
  }
  const description = (match ? match[2] : text).trim() || undefined;

  for (const key of Object.keys(data)) {
    if (!["title", "slug", "priority", "order"].includes(key)) warn(`${SIDECAR}: unknown field "${key}" ignored`);
  }

  const asText = (key) => {
    const value = data[key];
    if (value == null) return undefined;
    if (typeof value !== "string" && typeof value !== "number") throw new Error(`${SIDECAR}: "${key}" must be text.`);
    return String(value).trim() || undefined;
  };

  const title = asText("title");
  const slug = asText("slug");
  if (slug && !SLUG_PATTERN.test(slug)) {
    throw new Error(`${SIDECAR}: slug "${slug}" may only contain a-z, 0-9 and single dashes.`);
  }

  const priority = data.priority;
  if (priority != null && !Number.isFinite(priority)) throw new Error(`${SIDECAR}: "priority" must be a number.`);

  const order = data.order;
  if (order != null && (!Array.isArray(order) || order.some((f) => typeof f !== "string"))) {
    throw new Error(`${SIDECAR}: "order" must be a list of file names.`);
  }

  return { title, slug, priority: priority ?? undefined, order: order ?? undefined, description };
}

/** Files listed in `order` first (in that order), then the rest alphabetically. */
function orderImages(files, order, warn) {
  if (!order?.length) return files;
  const byLowerName = new Map(files.map((f) => [f.toLowerCase(), f]));
  const ordered = [];
  for (const name of order) {
    const file = byLowerName.get(name.toLowerCase());
    if (!file) warn(`${SIDECAR}: "order" lists "${name}", but there is no such image in the folder`);
    else if (!ordered.includes(file)) ordered.push(file);
  }
  return [...ordered, ...files.filter((f) => !ordered.includes(f))];
}

// ---------------------------------------------------------------------------------------------
// Images: embedded metadata and resizing

/** XMP "language alternative" values come as a string, {lang, value} or a list of those. */
function textValue(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const pick =
      value.find((v) => v?.lang === "x-default") ?? value.find((v) => v?.lang?.startsWith("fr")) ?? value[0];
    return textValue(pick);
  }
  if (typeof value === "object") return textValue(value.value);
  return String(value).trim() || undefined;
}

/** Title / alt / caption from XMP (dc, Iptc4xmpCore) or legacy IPTC fields. */
async function readEmbeddedText(buffer) {
  let meta;
  try {
    meta = await exifr.parse(buffer, {
      xmp: true,
      iptc: true,
      tiff: false,
      exif: false,
      gps: false,
      icc: false,
      jfif: false,
      ihdr: false,
      mergeOutput: false,
    });
  } catch {
    return {}; // unsupported format or no metadata
  }
  if (!meta) return {};

  const title = textValue(meta.dc?.title) ?? textValue(meta.iptc?.ObjectName);
  const description = textValue(meta.dc?.description) ?? textValue(meta.iptc?.Caption);
  const altText = textValue(meta.Iptc4xmpCore?.AltTextAccessibility);
  return { title, alt: altText ?? description, caption: description };
}

/** Pixel size after applying EXIF orientation. */
function orientedSize({ width, height, orientation }) {
  return orientation >= 5 ? { width: height, height: width } : { width, height };
}

function fitWithin(size, maxSize) {
  const scale = maxSize ? Math.min(1, maxSize / Math.max(size.width, size.height)) : 1;
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
}

/** Read a file and work out what will be uploaded. `encode: false` skips the (slow) re-encode. */
async function prepareImage(filePath, maxSize, { encode }) {
  const original = await readFile(filePath);
  const text = await readEmbeddedText(original);
  const source = orientedSize(await sharp(original).metadata());
  const basename = path.basename(filePath);

  if (!maxSize) {
    return { text, source, output: source, buffer: original, filename: basename, bytes: original.length };
  }

  const ext = path.extname(filePath).toLowerCase();
  const format = ext === ".png" ? "png" : ext === ".webp" ? "webp" : "jpg"; // tif → jpg
  const filename = `${stemOf(filePath)}.${format}`;
  if (!encode) return { text, source, output: fitWithin(source, maxSize), filename };

  const pipeline = sharp(original, { failOn: "error" })
    .rotate() // bake in EXIF orientation (metadata is dropped on output)
    .resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true })
    .withIccProfile("srgb");
  if (format === "png") pipeline.png({ compressionLevel: 9 });
  else if (format === "webp") pipeline.webp({ quality: 90 });
  else pipeline.jpeg({ quality: 90, mozjpeg: true });

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    text,
    source,
    output: { width: info.width, height: info.height },
    buffer: data,
    filename,
    bytes: data.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Import one gallery

const formatSize = ({ width, height }) => `${width}x${height}`;
const formatBytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);

async function listImages(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && isImage(e.name))
    .map((e) => e.name)
    .sort(byName);
}

/** @returns {"draft" | "published" | "unchanged" | "skipped" | "planned"} */
async function importGallery(client, dir, opts) {
  const warnings = [];
  const warn = (message) => warnings.push(message);

  const sidecar = await readSidecar(dir, warn);
  const title = sidecar.title ?? path.basename(dir);
  const slug = sidecar.slug ?? slugify(title);
  if (!slug) throw new Error(`Can't derive a slug from "${title}" — set "slug" in ${SIDECAR}.`);

  const files = orderImages(await listImages(dir), sidecar.order, warn);
  const existing = client ? await findGallery(client, slug) : null;

  const mode = existing ? (opts.replace ? "replace" : "merge") : "new";
  const header = `${title}  ->  /galleries/${slug}`;
  const modeLabel = { new: "new gallery", merge: `merge into ${existing?.id}`, replace: `replace ${existing?.id}` }[mode];
  console.log(`\n${header}  [${modeLabel}]`);
  for (const message of warnings) console.log(`  ! ${message}`);

  if (existing && opts.skipExisting) {
    console.log("  skipped (already exists, --skip-existing)");
    return "skipped";
  }
  if (files.length === 0 && !existing) {
    console.log("  skipped (no images)");
    return "skipped";
  }

  // Which files become new photos; in merge mode, images already in the gallery are kept as-is.
  const toAdd = mode === "merge" ? files.filter((f) => !isInGallery(existing, slug, f)) : files;
  for (const file of files) {
    if (!toAdd.includes(file)) console.log(`  = ${file}  (already in gallery)`);
  }

  // Leftovers from an interrupted run can be reused instead of uploaded again (merge/new only).
  const photoIds = new Map(toAdd.map((f) => [f, photoIdFor(slug, stemOf(f))]));
  const existingPhotoIds = client
    ? new Set(await client.fetch(`*[_id in $ids]._id`, { ids: [...photoIds.values()] }))
    : new Set();

  const refs = [];
  for (const file of toAdd) {
    const photoId = photoIds.get(file);
    const reuse = existingPhotoIds.has(photoId) && mode !== "replace";
    const ref = { _type: "reference", _ref: photoId, _key: shortHash(photoId).slice(0, 12) };

    if (reuse) {
      console.log(`  + ${file}  (photo already uploaded, reusing)`);
      refs.push(ref);
      continue;
    }

    const image = await prepareImage(path.join(dir, file), opts.maxSize, { encode: !opts.dryRun });
    const resized =
      image.output.width !== image.source.width ? ` -> ${formatSize(image.output)}` : "";
    const found = [
      image.text.title && `title "${image.text.title}"`,
      image.text.alt ? "alt text" : "no alt text",
      image.text.caption && image.text.caption !== image.text.alt && "caption",
    ].filter(Boolean);
    const size = image.bytes ? `, ${formatBytes(image.bytes)}` : "";
    console.log(`  + ${file}  ${formatSize(image.source)}${resized}${size} · ${found.join(", ")}`);

    if (opts.dryRun) {
      refs.push(ref);
      continue;
    }

    const asset = await client.assets.upload("image", image.buffer, {
      filename: image.filename,
      // Lets cleanup-imports.mjs recognise files left behind if the import fails after uploading.
      source: { name: IMPORT_SOURCE, id: photoId },
    });
    const photo = {
      _id: photoId,
      _type: "photo",
      title: image.text.title ?? stemOf(file),
      image: { _type: "image", asset: { _type: "reference", _ref: asset._id } },
      ...(image.text.alt && { alt: image.text.alt }),
      ...(image.text.caption && { caption: image.text.caption }),
    };
    // Photos are published directly; drop any stale draft so Studio shows the new version.
    await client.transaction().createOrReplace(photo).delete(draftId(photoId)).commit();
    refs.push(ref);
  }

  // Gallery document changes.
  let galleryId;
  let changes;
  if (mode === "new") {
    galleryId = await newGalleryId(client, slug);
    changes = {
      create: {
        _id: draftId(galleryId),
        _type: "gallery",
        title,
        slug: { _type: "slug", current: slug },
        priority: sidecar.priority ?? 0,
        photos: refs,
        ...(sidecar.description && { description: sidecar.description }),
      },
    };
  } else {
    galleryId = existing.id;
    const current = existing.current;
    const set = {};
    const fill = (field, value) => {
      if (value === undefined) return;
      const isEmpty = current[field] == null || current[field] === "";
      if (mode === "replace" ? current[field] !== value : isEmpty) set[field] = value;
    };
    fill("title", sidecar.title);
    fill("description", sidecar.description);
    fill("priority", sidecar.priority);
    if (mode === "replace") set.photos = refs;
    changes = { set, append: mode === "merge" ? refs : [] };

    const nothingToDo = Object.keys(set).length === 0 && changes.append.length === 0;
    if (nothingToDo) {
      if (opts.publish && existing.draft && !opts.dryRun) {
        await publish(client, galleryId);
        console.log("  nothing new; published the existing draft (--publish)");
        return "published";
      }
      console.log("  up to date, nothing to do");
      return "unchanged";
    }
    const fields = Object.keys(set);
    if (fields.length) console.log(`  ~ gallery fields: ${fields.join(", ")}`);
  }

  if (opts.dryRun) {
    console.log(`  (dry run) would save ${opts.publish ? "and publish" : "a draft of"} ${galleryId}`);
    return "planned";
  }

  const tx = client.transaction();
  if (changes.create) {
    tx.create(changes.create);
  } else {
    // Work on the draft so the live site doesn't change until the gallery is published.
    if (!existing.draft) {
      const { photoFiles, ...published } = stripSystemFields(existing.published);
      tx.createIfNotExists({ ...published, _id: draftId(galleryId) });
    }
    const patch = client.patch(draftId(galleryId));
    if (Object.keys(changes.set).length) patch.set(changes.set);
    if (changes.append.length) patch.setIfMissing({ photos: [] }).append("photos", changes.append);
    tx.patch(patch);
  }
  await tx.commit();

  if (opts.publish) {
    await publish(client, galleryId);
    console.log(`  published ${galleryId}`);
    return "published";
  }
  console.log(`  draft saved (${galleryId}) — review and publish it in Studio`);
  return "draft";
}

function publish(client, id) {
  return client.action({
    actionType: "sanity.action.document.publish",
    publishedId: id,
    versionId: draftId(id),
  });
}

// ---------------------------------------------------------------------------------------------
// Main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.folder);

  try {
    if (!(await stat(root)).isDirectory()) throw new Error();
  } catch {
    fail(`Not a folder: ${root}`);
  }

  const dataset = resolveDataset(opts.dataset);
  const client = makeClient(dataset, { required: !opts.dryRun });

  // One gallery folder, or a folder of galleries?
  const entries = await readdir(root, { withFileTypes: true });
  const isGalleryFolder = entries.some((e) => e.isFile() && (isImage(e.name) || e.name === SIDECAR));
  const dirs = isGalleryFolder
    ? [root]
    : entries
        .filter((e) => e.isDirectory())
        .map((e) => path.join(root, e.name))
        .sort(byName);

  if (dirs.length === 0) {
    console.log(`No images, ${SIDECAR} or subfolders in ${root}`);
    return;
  }

  console.log(
    `${opts.dryRun ? "Dry run: " : ""}${dirs.length} galler${dirs.length === 1 ? "y" : "ies"} from ${root}` +
      ` -> dataset "${dataset}"` +
      ` · images ${opts.maxSize ? `<= ${opts.maxSize}px` : "uploaded as originals"}`,
  );
  if (!client) console.log("(no Sanity credentials: assuming every gallery is new)");

  const results = [];
  for (const dir of dirs) {
    try {
      results.push(await importGallery(client, dir, opts));
    } catch (err) {
      console.error(`\n${path.basename(dir)}\n  FAILED: ${err.message || err}`);
      results.push("failed");
      process.exitCode = 1;
    }
  }

  const count = (r) => results.filter((x) => x === r).length;
  const summary = ["planned", "draft", "published", "unchanged", "skipped", "failed"]
    .filter((r) => count(r))
    .map((r) => `${count(r)} ${r}`);
  console.log(`\nDone: ${summary.join(", ")}.`);
  if (count("draft")) {
    console.log("Drafts aren't on the site yet: publish them in Studio (or re-run with --publish).");
  }
  if (count("draft") || count("published")) {
    console.log("The site updates on the next Netlify build.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
