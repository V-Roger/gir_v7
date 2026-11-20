import type { QueryParams } from "@sanity/client";
import { sanityClient } from "sanity:client";
import { SITE_SETTINGS_QUERY } from "./queries";
import type { SiteSettings } from "./types";

const DEFAULT_SITE_TITLE = "Portfolio";

/**
 * Typed Sanity fetch.
 * In production builds a failure throws, so a broken token/network never deploys an empty site.
 * In dev it logs and returns `fallback` so you can work without CMS access.
 */
export async function sanityFetch<T>(
  query: string,
  fallback: T,
  params: QueryParams = {},
): Promise<T> {
  try {
    return (await sanityClient.fetch<T>(query, params)) ?? fallback;
  } catch (err) {
    if (import.meta.env.PROD) {
      throw new Error("Sanity fetch failed — check PUBLIC_SANITY_PROJECT_ID, dataset and token.", {
        cause: err,
      });
    }
    console.warn("Sanity fetch failed — using fallback content.", err);
    return fallback;
  }
}

let siteSettingsPromise: Promise<SiteSettings | null> | undefined;

/**
 * Site settings, fetched once per build and shared by every page.
 * Not cached in dev, so Studio edits show up on refresh.
 */
export function getSiteSettings(): Promise<SiteSettings | null> {
  const load = () => sanityFetch<SiteSettings | null>(SITE_SETTINGS_QUERY, null);
  if (!import.meta.env.PROD) return load();
  siteSettingsPromise ??= load();
  return siteSettingsPromise;
}

export function siteTitleOf(settings: SiteSettings | null): string {
  return settings?.title ?? DEFAULT_SITE_TITLE;
}

/** `Site title — Tagline`, or just the site title. */
export function homeTitleOf(settings: SiteSettings | null): string {
  const siteTitle = siteTitleOf(settings);
  return settings?.tagline ? `${siteTitle} — ${settings.tagline}` : siteTitle;
}
