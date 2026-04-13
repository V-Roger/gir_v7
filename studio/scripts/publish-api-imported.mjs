#!/usr/bin/env node
/**
 * One-off: documents created with createOrReplace at published-looking ids are not
 * visible to unauthenticated Content Lake queries. This copies each matching doc into
 * drafts.<id> and runs sanity.action.document.publish (versionId + publishedId) so the
 * public API sees them.
 *
 * Targets _id matching importPhoto.* and importGallery.* (batch import stable ids).
 *
 *   node --env-file=.env scripts/publish-api-imported.mjs
 */

import { createClient } from "@sanity/client";

function makeClient() {
  const projectId =
    process.env.SANITY_STUDIO_PROJECT_ID || process.env.SANITY_PROJECT_ID;
  const dataset =
    process.env.SANITY_STUDIO_DATASET || process.env.SANITY_DATASET || "production";
  const token =
    process.env.SANITY_API_WRITE_TOKEN ||
    process.env.SANITY_API_TOKEN ||
    process.env.SANITY_TOKEN;

  if (!projectId || !token) {
    console.error("Need SANITY_STUDIO_PROJECT_ID and SANITY_API_WRITE_TOKEN.");
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

function versionDocumentId(publishedId) {
  return publishedId.startsWith("drafts.") ? publishedId : `drafts.${publishedId}`;
}

/** Map drafts.importFoo or importFoo → importFoo (published id). */
function publishedIdFromAny(id) {
  return id.startsWith("drafts.") ? id.slice("drafts.".length) : id;
}

function stripSystemFields(doc) {
  const o = { ...doc };
  delete o._rev;
  delete o._createdAt;
  delete o._updatedAt;
  delete o._originalId;
  return o;
}

async function ensurePublished(client, publishedId) {
  if (publishedId.startsWith("drafts.")) return;

  const dId = versionDocumentId(publishedId);
  const draftExists = await client.fetch(`count(*[_id == $id]) > 0`, { id: dId });
  if (!draftExists) {
    const doc = await client.fetch(`*[_id == $id][0]`, { id: publishedId });
    if (!doc) {
      console.warn(`Skip (missing): ${publishedId}`);
      return;
    }
    const payload = stripSystemFields(doc);
    payload._id = dId;
    await client.createOrReplace(payload);
  }

  await client.action({
    actionType: "sanity.action.document.publish",
    publishedId,
    versionId: dId,
  });
  console.log(`Published: ${publishedId}`);
}

async function main() {
  const client = makeClient();

  const photoIds = await client.fetch(
    `*[(_id match "importPhoto.*") || (_id match "drafts.importPhoto.*")] | order(_id) { _id }`
  );
  const galleryIds = await client.fetch(
    `*[(_id match "importGallery.*") || (_id match "drafts.importGallery.*")] | order(_id) { _id }`
  );

  const photos = [...new Set(photoIds.map((r) => publishedIdFromAny(r._id)))];
  const galleries = [...new Set(galleryIds.map((r) => publishedIdFromAny(r._id)))];

  if (photos.length === 0 && galleries.length === 0) {
    console.log("No importPhoto.* / importGallery.* documents found.");
    return;
  }

  for (const id of photos) {
    await ensurePublished(client, id);
  }
  for (const id of galleries) {
    await ensurePublished(client, id);
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
