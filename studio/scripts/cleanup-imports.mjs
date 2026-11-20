#!/usr/bin/env node
/**
 * Clean up after failed or unwanted gallery imports. Previews by default; --apply deletes.
 *
 *   pnpm cleanup-imports -- --gallery <slug>        # discard a gallery's draft + its now-unused photos
 *   pnpm cleanup-imports -- --gallery <slug> --include-published   # delete the whole gallery
 *   pnpm cleanup-imports -- --orphans               # photos in no gallery + unused image files
 *   ... --apply                                     # actually delete
 *
 * --gallery <slug> (or --id <documentId>)
 *   Deletes the gallery's DRAFT: an import that went wrong (new gallery, never published) or
 *   photos a merge added to a live gallery. The published version stays unless you pass
 *   --include-published, which deletes the gallery entirely.
 *   Photos referenced only by what is deleted are deleted too, then their image files if
 *   nothing else uses them. Photos still used elsewhere (e.g. by the published version) stay.
 *
 * --orphans
 *   Leftovers from an import that stopped halfway: photo documents the import created that no
 *   gallery (draft or published) references, and image files it uploaded that nothing uses.
 *   Photos and images you added in Studio are left alone; --all includes them too (every
 *   unused photo and image file, e.g. an old cover picture).
 *   Anything created in the last --min-age minutes (default 30) is ignored, so an import still
 *   running isn't touched: its photos look unreferenced until it saves the gallery at the end.
 *
 * Safety
 *   - An image file counts as used if any document references it OR mentions it in text:
 *     images dragged into Markdown descriptions are linked by URL, not by reference.
 *   - Release versions (versions.*) are never deleted and count as users.
 *   - Deleting an image file removes it from the CDN for good; --keep-assets skips files.
 *     Make a backup first if unsure: `npx sanity dataset export production backup.tar.gz`.
 *
 * Options: --apply, --all, --dataset <name>, --min-age <minutes>, --keep-assets
 */

import {
  IMPORT_SOURCE,
  draftId,
  isImportPhotoId,
  makeClient,
  publishedId,
  resolveDataset,
} from "./lib/sanity.mjs";

const USAGE = `Usage:
  pnpm cleanup-imports -- --gallery <slug> [--include-published] [--apply]
  pnpm cleanup-imports -- --id <documentId> [--include-published] [--apply]
  pnpm cleanup-imports -- --orphans [--all] [--min-age <minutes>] [--apply]

  --apply               Delete. Without it (or with --dry-run) nothing is deleted.
  --all                 With --orphans: every unused photo/image, not only import leftovers.
  --keep-assets         Keep image files; delete documents only.
  --dataset <name>      Target dataset (default SANITY_STUDIO_DATASET or "production").

See the header of scripts/cleanup-imports.mjs for details.`;

function fail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    gallery: undefined,
    id: undefined,
    orphans: false,
    all: false,
    includePublished: false,
    apply: false,
    dryRun: false,
    keepAssets: false,
    minAge: 30,
    dataset: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].startsWith("--") ? argv[i].split(/=(.*)/s) : [argv[i]];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith("--")) fail(`${flag} needs a value.`);
      return v;
    };
    switch (flag) {
      case "--":
        break;
      case "--gallery":
        opts.gallery = value();
        break;
      case "--id":
        opts.id = value();
        break;
      case "--orphans":
        opts.orphans = true;
        break;
      case "--all":
        opts.all = true;
        break;
      case "--include-published":
        opts.includePublished = true;
        break;
      case "--apply":
        opts.apply = true;
        break;
      case "--dry-run": // the default; accepted for consistency with the other scripts
        opts.dryRun = true;
        break;
      case "--keep-assets":
        opts.keepAssets = true;
        break;
      case "--min-age":
        opts.minAge = Number(value());
        break;
      case "--dataset":
        opts.dataset = value();
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`Unknown argument: ${argv[i]}`);
    }
  }
  const modes = [opts.gallery, opts.id, opts.orphans || undefined].filter(Boolean).length;
  if (modes !== 1) fail("Choose exactly one of --gallery, --id or --orphans.");
  if (!Number.isFinite(opts.minAge) || opts.minAge < 0) fail("--min-age must be a number of minutes ≥ 0.");
  if (opts.includePublished && opts.orphans) fail("--include-published only applies to --gallery / --id.");
  if (opts.all && !opts.orphans) fail("--all only applies to --orphans.");
  if (opts.apply && opts.dryRun) fail("--apply and --dry-run contradict each other.");
  return opts;
}

// ---------------------------------------------------------------------------------------------
// Dataset snapshot: everything is decided from one consistent read.

const isVersion = (id) => id.startsWith("versions.");

/** All `_ref` values inside a document (strong and weak). */
function refsOf(doc) {
  const refs = new Set();
  JSON.stringify(doc, (key, value) => {
    if (key === "_ref" && typeof value === "string") refs.add(publishedId(value));
    return value;
  });
  return refs;
}

async function loadSnapshot(client) {
  // Small datasets (a portfolio): reading everything keeps the reasoning simple and exact.
  const all = await client.fetch(`*[!(_id in path("_.**"))]`);
  const assets = new Map(all.filter((d) => d._type === "sanity.imageAsset").map((a) => [a._id, a]));
  const docs = all.filter((d) => !d._type.startsWith("sanity."));
  const byId = new Map(docs.map((d) => [d._id, d]));
  const refs = new Map(docs.map((d) => [d._id, refsOf(d)]));
  const text = new Map(docs.map((d) => [d._id, JSON.stringify(d)]));
  return { docs, byId, refs, text, assets };
}

/** Ids (any version) that still reference `target` once `deleted` are gone. */
function remainingReferrers(snapshot, target, deleted) {
  const users = [];
  for (const [id, refs] of snapshot.refs) if (!deleted.has(id) && refs.has(target)) users.push(id);
  return users;
}

/** Is an image file still used once `deleted` are gone (reference or URL in any text)? */
function assetInUse(snapshot, asset, deleted) {
  if (remainingReferrers(snapshot, asset._id, deleted).length) return true;
  const sha = asset.assetId ?? asset._id.split("-")[1];
  for (const [id, text] of snapshot.text) if (!deleted.has(id) && text.includes(sha)) return true;
  return false;
}

const versionsOf = (snapshot, id) => [id, draftId(id)].filter((v) => snapshot.byId.has(v));

/** Photos (all versions) that become unreferenced once `deleted` are gone, then their assets. */
function cascade(snapshot, candidatePhotoIds, deleted, { keepAssets }) {
  const photos = [];
  for (const id of candidatePhotoIds) {
    const versions = versionsOf(snapshot, id);
    if (versions.length === 0) continue;
    const users = remainingReferrers(snapshot, id, new Set([...deleted, ...versions]));
    if (users.length) continue;
    photos.push(id);
    for (const v of versions) deleted.add(v);
  }

  const assets = [];
  if (!keepAssets) {
    const candidates = new Set();
    for (const id of photos) {
      for (const v of versionsOf(snapshot, id)) {
        for (const ref of snapshot.refs.get(v)) if (snapshot.assets.has(ref)) candidates.add(ref);
      }
    }
    for (const assetId of candidates) {
      if (!assetInUse(snapshot, snapshot.assets.get(assetId), deleted)) assets.push(assetId);
    }
  }
  return { photos, assets };
}

// ---------------------------------------------------------------------------------------------
// Plans

function describePhoto(snapshot, id) {
  const doc = snapshot.byId.get(id) ?? snapshot.byId.get(draftId(id));
  const asset = snapshot.assets.get([...(snapshot.refs.get(doc._id) ?? [])].find((r) => snapshot.assets.has(r)));
  return `${id}  "${doc.title ?? ""}"${asset?.originalFilename ? `  (${asset.originalFilename})` : ""}`;
}

const formatBytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);

function planGallery(snapshot, opts) {
  let ids;
  if (opts.id) {
    ids = [publishedId(opts.id)];
    if (versionsOf(snapshot, ids[0]).length === 0) throw new Error(`No document with id "${opts.id}".`);
    const doc = snapshot.byId.get(ids[0]) ?? snapshot.byId.get(draftId(ids[0]));
    if (doc._type !== "gallery") throw new Error(`"${opts.id}" is a ${doc._type}, not a gallery.`);
  } else {
    const matches = snapshot.docs.filter((d) => d._type === "gallery" && !isVersion(d._id) && d.slug?.current === opts.gallery);
    ids = [...new Set(matches.map((d) => publishedId(d._id)))];
    if (ids.length === 0) throw new Error(`No gallery with slug "${opts.gallery}".`);
    if (ids.length > 1) {
      throw new Error(`Several galleries use the slug "${opts.gallery}": ${ids.join(", ")}. Pick one with --id.`);
    }
  }

  const id = ids[0];
  const draft = snapshot.byId.get(draftId(id));
  const published = snapshot.byId.get(id);
  const targets = [];
  if (draft) targets.push(draft._id);
  if (published && opts.includePublished) targets.push(published._id);

  const label = (draft ?? published).title ?? id;
  if (targets.length === 0) {
    throw new Error(
      `"${label}" (${id}) has no draft; it is live. Pass --include-published to delete the published gallery.`,
    );
  }

  const deleted = new Set(targets);
  const candidatePhotos = new Set(targets.flatMap((t) => [...snapshot.refs.get(t)]).filter((r) => {
    const doc = snapshot.byId.get(r) ?? snapshot.byId.get(draftId(r));
    return doc?._type === "photo";
  }));
  const { photos, assets } = cascade(snapshot, candidatePhotos, deleted, opts);

  const what = targets.length === 2 ? "whole gallery (draft + published)" : draft ? "draft" : "published gallery";
  const lines = [`Gallery "${label}" (${id}): delete ${what}`];
  if (published && !opts.includePublished) lines.push("  the published version stays live");
  const kept = candidatePhotos.size - photos.length;
  if (kept) lines.push(`  ${kept} photo(s) stay: still used by ${published && !opts.includePublished ? "the published version or " : ""}another gallery`);
  return { lines, docs: targets, photos, assets };
}

function planOrphans(snapshot, opts) {
  const cutoff = Date.now() - opts.minAge * 60_000;
  const old = (doc) => Date.parse(doc._createdAt) < cutoff;
  const scope = opts.all ? "all unused photos and image files" : "import leftovers";
  const lines = [`Orphans: ${scope}, created more than ${opts.minAge} min ago`];

  const photoIds = new Set(
    snapshot.docs
      .filter((d) => d._type === "photo" && !isVersion(d._id) && old(d))
      .map((d) => publishedId(d._id))
      .filter((id) => opts.all || isImportPhotoId(id)),
  );
  const deleted = new Set();
  const { photos, assets: photoAssets } = cascade(snapshot, photoIds, deleted, opts);

  // Image files nothing uses at all (e.g. upload succeeded, photo document wasn't created).
  const assets = [...photoAssets];
  if (!opts.keepAssets) {
    for (const asset of snapshot.assets.values()) {
      const inScope = opts.all || asset.source?.name === IMPORT_SOURCE;
      if (inScope && !assets.includes(asset._id) && old(asset) && !assetInUse(snapshot, asset, deleted)) {
        assets.push(asset._id);
      }
    }
  }
  return { lines, docs: [], photos, assets };
}

// ---------------------------------------------------------------------------------------------
// Main

async function deleteInBatches(client, ids, size = 100) {
  for (let i = 0; i < ids.length; i += size) {
    const tx = client.transaction();
    for (const id of ids.slice(i, i + size)) tx.delete(id);
    await tx.commit({ visibility: "sync" });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dataset = resolveDataset(opts.dataset);
  const client = makeClient(dataset, { required: true });
  const snapshot = await loadSnapshot(client);

  const plan = opts.orphans ? planOrphans(snapshot, opts) : planGallery(snapshot, opts);
  const photoVersions = plan.photos.flatMap((id) => versionsOf(snapshot, id));
  const bytes = plan.assets.reduce((sum, id) => sum + (snapshot.assets.get(id).size ?? 0), 0);

  console.log(`${opts.apply ? "" : "Dry run: "}dataset "${dataset}"\n`);
  for (const line of plan.lines) console.log(line);
  for (const id of plan.docs) console.log(`  - ${id}`);
  console.log(`  ${plan.photos.length} photo(s) to delete${plan.photos.length ? ":" : ""}`);
  for (const id of plan.photos) console.log(`    - ${describePhoto(snapshot, id)}`);
  if (opts.keepAssets) console.log("  image files kept (--keep-assets)");
  else {
    console.log(`  ${plan.assets.length} image file(s) to delete${plan.assets.length ? ` (${formatBytes(bytes)}):` : ""}`);
    for (const id of plan.assets) console.log(`    - ${snapshot.assets.get(id).originalFilename ?? id}  [${id}]`);
  }

  const total = plan.docs.length + photoVersions.length + plan.assets.length;
  if (total === 0) {
    console.log("\nNothing to delete.");
    return;
  }
  if (!opts.apply) {
    console.log(`\nNothing deleted. Re-run with --apply to delete these ${total} document(s)/file(s).`);
    return;
  }

  // Documents first (gallery, then photos) in one transaction, so references never dangle;
  // image files afterwards, once nothing points at them.
  await deleteInBatches(client, [...plan.docs, ...photoVersions], Number.MAX_SAFE_INTEGER);
  if (plan.assets.length) await deleteInBatches(client, plan.assets);
  console.log(`\nDeleted ${plan.docs.length + photoVersions.length} document(s) and ${plan.assets.length} image file(s).`);
  if (plan.docs.some((id) => !id.startsWith("drafts."))) console.log("The site updates on the next Netlify build.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
