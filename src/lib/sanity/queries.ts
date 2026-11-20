/**
 * Image projection: keeps crop/hotspot for the URL builder and only the asset metadata we use.
 * Spread into a field projection, e.g. `image{ ${IMAGE_FIELDS} }`.
 */
const IMAGE_FIELDS = `
  _type,
  crop,
  hotspot,
  asset->{ _id, metadata{ dimensions, lqip } }
`;

const EXHIBITION_FIELDS = `
  _id,
  title,
  description,
  year,
  location,
  city,
  country
`;

/** The `siteSettings` singleton (see `studio/structure.ts`). */
export const SITE_SETTINGS_QUERY = `*[_type == "siteSettings"][0]{
  title,
  cover{ ${IMAGE_FIELDS} },
  "coverAlt": cover.alt,
  tagline,
  about,
  socialLinks
}`;

export const GALLERIES_INDEX_QUERY = `*[_type == "gallery"] | order(priority asc, title asc) {
  _id,
  title,
  "slug": slug.current,
  "cover": photos[0]->{
    image{ ${IMAGE_FIELDS} },
    alt
  }
}`;

/** All galleries with full detail — used once by `getStaticPaths`. */
export const GALLERIES_DETAIL_QUERY = `*[_type == "gallery" && defined(slug.current)]{
  _id,
  title,
  "slug": slug.current,
  description,
  "photos": photos[]->{
    _id,
    title,
    image{ ${IMAGE_FIELDS} },
    alt,
    caption
  },
  "exhibitions": exhibitions[]->{ ${EXHIBITION_FIELDS} }
}`;

export const PUBLICATIONS_QUERY = `*[_type == "publication"] | order(year desc) {
  _id,
  title,
  description,
  year
}`;

export const EXHIBITIONS_QUERY = `*[_type == "exhibition"] | order(year desc) { ${EXHIBITION_FIELDS} }`;
