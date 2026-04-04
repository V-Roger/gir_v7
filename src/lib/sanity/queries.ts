/** Singleton site settings document id used in Studio structure. */
export const SITE_SETTINGS_QUERY = `*[_type == "siteSettings"][0]{
  title,
  tagline,
  about,
  socialLinks
}`;

export const GALLERIES_INDEX_QUERY = `*[_type == "gallery"] | order(title asc) {
  _id,
  title,
  "slug": slug.current,
  description,
  "cover": photos[0]->{
    image,
    alt
  }
}`;

export const GALLERY_BY_SLUG_QUERY = `*[_type == "gallery" && slug.current == $slug][0]{
  _id,
  title,
  "slug": slug.current,
  description,
  "photos": photos[]->{
    _id,
    title,
    image,
    alt,
    caption,
    dateTaken
  }
}`;

export const GALLERY_SLUGS_QUERY = `*[_type == "gallery" && defined(slug.current)]{
  "slug": slug.current
}`;
