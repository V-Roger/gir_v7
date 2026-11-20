#!/usr/bin/env node
/**
 * Move galleries and photos created by the old import (`importGallery.<slug>`,
 * `importPhoto.<slug>.<hash>`) to dot-free ids (`gallery-<slug>`, `photo-<hash>`).
 *
 * Why: Sanity treats ids containing a dot as private, so the public API can't read them and
 * the site only works with a read token. The new ids match what `import-galleries.mjs`
 * generates, so later imports recognise the migrated photos.
 *
 *   pnpm migrate-legacy-ids -- --dry-run     # show the plan, write nothing
 *   pnpm migrate-legacy-ids                  # migrate
 *
 * Each gallery moves in ONE transaction: its photos are copied to new ids, the gallery is
 * copied with its references updated, then the old documents are deleted. If the script is
 * interrupted, every gallery is either fully migrated or untouched; re-run it to continue.
 * Content, images (assets), exhibitions and field values are unchanged. Studio's change
 * history for these documents starts over under the new ids.
 *
 * Options: --dry-run, --dataset <name>
 */

import {
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

const LEGACY_QUERY = `*[
  string::startsWith(_id, "importGallery.") || string::startsWith(_id, "drafts.importGallery.") ||
  string::startsWith(_id, "importPhoto.") || string::startsWith(_id, "drafts.importPhoto.")
]{ ..., "originalFilename": image.asset->originalFilename }`;

function parseArgs(argv) {
  const opts = { dryRun: false, dataset: undefined };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag === "--") continue;
    else if (flag === "--dry-run") opts.dryRun = true;
    else if (flag === "--dataset") opts.dataset = inline ?? argv[++i];
    else {
      console.error(`Unknown argument: ${argv[i]}\nUsage: pnpm migrate-legacy-ids -- [--dry-run] [--dataset <name>]`);
      process.exit(1);
    }
  }
  return opts;
}

/** Group published + draft versions by published id. */
function groupVersions(docs) {
  const groups = new Map();
  for (const doc of docs) {
    const id = publishedId(doc._id);
    const group = groups.get(id) ?? { id, published: null, draft: null };
    if (doc._id.startsWith("drafts.")) group.draft = doc;
    else group.published = doc;
    groups.set(id, group);
  }
  return groups;
}

/** Deep copy with every `_ref` found in `idMap` replaced. */
function remapRefs(value, idMap) {
  if (Array.isArray(value)) return value.map((v) => remapRefs(v, idMap));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = key === "_ref" && idMap.has(v) ? idMap.get(v) : remapRefs(v, idMap);
    }
    return out;
  }
  return value;
}

/** Copy one document group (published and/or draft) to a new id. */
function copyGroup(group, newId, idMap) {
  const copies = [];
  for (const doc of [group.published, group.draft]) {
    if (!doc) continue;
    const { originalFilename, ...fields } = stripSystemFields(doc);
    const _id = doc._id.startsWith("drafts.") ? draftId(newId) : newId;
    copies.push(remapRefs({ ...fields, _id }, idMap));
  }
  return copies;
}

const idsOf = (group) => [group.published?._id, group.draft?._id].filter(Boolean);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dataset = resolveDataset(opts.dataset);
  const client = makeClient(dataset, { required: true });

  const legacy = await client.fetch(LEGACY_QUERY);
  const groups = groupVersions(legacy);
  const galleries = [...groups.values()].filter((g) => (g.published ?? g.draft)._type === "gallery");
  const photos = new Map([...groups].filter(([, g]) => (g.published ?? g.draft)._type === "photo"));

  console.log(
    `${opts.dryRun ? "Dry run: " : ""}dataset "${dataset}": ${galleries.length} legacy galleries, ${photos.size} legacy photos`,
  );
  if (groups.size === 0) {
    console.log("Nothing to migrate.");
    return;
  }

  // Refuse to run if anything outside this set references it; we'd have to rewrite those too.
  const legacyIds = legacy.map((d) => d._id);
  const outsideReferrers = await client.fetch(
    `*[references($ids) && !(_id in $ids)]._id`,
    { ids: [...new Set([...legacyIds, ...legacyIds.map(publishedId)])] },
  );
  if (outsideReferrers.length) {
    throw new Error(
      `Other documents reference legacy ids (${outsideReferrers.join(", ")}). Not supported; nothing was changed.`,
    );
  }

  // Plan new ids. Avoid any id that's already taken or planned twice.
  const taken = new Set(await client.fetch(`*[!(_id in path("drafts.**"))]._id`));
  const claim = (preferred, fallback) => {
    const id = taken.has(preferred) ? fallback : preferred;
    if (taken.has(id)) throw new Error(`Id ${id} is already taken; nothing was changed.`);
    taken.add(id);
    return id;
  };

  const idMap = new Map(); // old published id -> new published id
  const owner = new Map(); // photo id -> gallery group
  const plan = [];
  for (const gallery of galleries.sort((a, b) => a.id.localeCompare(b.id))) {
    const doc = gallery.draft ?? gallery.published;
    const slug = doc.slug?.current;
    if (!slug) throw new Error(`${gallery.id} has no slug; fix it in Studio first. Nothing was changed.`);
    const newId = claim(galleryIdFor(slug), `${galleryIdFor(slug)}-${shortHash(gallery.id).slice(0, 6)}`);
    idMap.set(gallery.id, newId);

    const refs = [gallery.published, gallery.draft].flatMap((d) => d?.photos ?? []).map((r) => r._ref);
    const galleryPhotos = [];
    for (const ref of new Set(refs)) {
      const photo = photos.get(ref);
      if (!photo || owner.has(ref)) continue; // non-legacy photo, or already planned
      owner.set(ref, gallery);
      const file = (photo.published ?? photo.draft).originalFilename;
      const preferred = file ? photoIdFor(slug, stemOf(file)) : undefined;
      const newPhotoId = claim(preferred ?? `photo-${shortHash(ref)}`, `photo-${shortHash(ref)}`);
      idMap.set(ref, newPhotoId);
      galleryPhotos.push(photo);
    }
    plan.push({ gallery, newId, slug, photos: galleryPhotos, keptRefs: refs.filter((r) => !photos.has(r)).length });
  }

  // Legacy photos no gallery references: move them too, so no private documents remain.
  const orphans = [...photos.values()].filter((p) => !owner.has(p.id));
  for (const photo of orphans) idMap.set(photo.id, claim(`photo-${shortHash(photo.id)}`, `photo-${shortHash(photo.id, "2")}`));

  for (const { gallery, newId, slug, photos: ps, keptRefs } of plan) {
    const drafts = gallery.draft ? " (+ draft)" : "";
    const kept = keptRefs ? `, ${keptRefs} non-legacy photo ref(s) kept as-is` : "";
    console.log(`  ${gallery.id}${drafts}  ->  ${newId}   /galleries/${slug}, ${ps.length} photos${kept}`);
  }
  if (orphans.length) console.log(`  ${orphans.length} unreferenced legacy photo(s) -> photo-<hash> (kept, not deleted)`);

  if (opts.dryRun) {
    console.log("\nDry run: nothing written.");
    return;
  }

  // Execute: one atomic transaction per gallery, then one for orphans.
  let done = 0;
  for (const { gallery, newId, photos: ps } of plan) {
    const tx = client.transaction();
    for (const photo of ps) for (const copy of copyGroup(photo, idMap.get(photo.id), idMap)) tx.create(copy);
    for (const copy of copyGroup(gallery, newId, idMap)) tx.create(copy);
    for (const id of idsOf(gallery)) tx.delete(id);
    for (const photo of ps) for (const id of idsOf(photo)) tx.delete(id);
    await tx.commit({ visibility: "sync" });
    done++;
    console.log(`  migrated ${gallery.id} -> ${newId} (${ps.length} photos)  [${done}/${plan.length}]`);
  }
  if (orphans.length) {
    const tx = client.transaction();
    for (const photo of orphans) {
      for (const copy of copyGroup(photo, idMap.get(photo.id), idMap)) tx.create(copy);
      for (const id of idsOf(photo)) tx.delete(id);
    }
    await tx.commit({ visibility: "sync" });
    console.log(`  migrated ${orphans.length} unreferenced photo(s)`);
  }

  const remaining = (await client.fetch(LEGACY_QUERY)).length;
  console.log(remaining === 0 ? "\nDone: no legacy ids left." : `\nWARNING: ${remaining} legacy document(s) remain.`);
  if (remaining) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
