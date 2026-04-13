/** Singleton site settings document id used in Studio structure. */
export const SITE_SETTINGS_QUERY = `*[_type == "siteSettings"][0]{
  title,
  "cover": select(defined(cover) => {
    "image": cover,
    "alt": cover.alt
  }),
  tagline,
  about,
  socialLinks
}`;

export const GALLERIES_INDEX_QUERY = `*[_type == "gallery"] | order(priority asc, title asc) {
  _id,
  title,
  "slug": slug.current,
  description,
  priority,
  "cover": photos[0]->{
    "image": image.asset->{
      _id,
      url,
      metadata
    },
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
    "image": image.asset->{
      _id,
      url,
      metadata
    },
    alt,
    caption,
    dateTaken
  },
  "exhibitions": exhibitions[]->{
    _id,
    title,
    description,
    year,
    location,
    city,
    country
  }
}`;

export const GALLERY_SLUGS_QUERY = `*[_type == "gallery" && defined(slug.current)]{
  "slug": slug.current
}`;

export const EXHIBITIONS_BY_GALLERY_ID_QUERY = `*[_type == "exhibition" && references($galleryId)] {
  _id,
  title,
  description,
  year,
  location,
  city,
  country
}`;

export const PUBLICATIONS_QUERY = `*[_type == "publication"] | order(year desc) {
  _id,
  title,
  description,
  year
}`;

export const EXHIBITIONS_QUERY = `*[_type == "exhibition"] | order(year desc) {
  _id,
  title,
  description,
  year,
  location,
  city,
  country
}`;