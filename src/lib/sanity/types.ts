/**
 * Shapes returned by the GROQ queries in `./queries.ts` (not the raw Studio documents).
 * Keep in sync with `studio/schemaTypes`.
 */

/** Image field projected as `image{ crop, hotspot, asset->{ _id, metadata{ dimensions, lqip } } }`. */
export interface SanityImage {
  _type?: "image";
  crop?: { top?: number; bottom?: number; left?: number; right?: number };
  hotspot?: { x?: number; y?: number; width?: number; height?: number };
  asset?: {
    _id: string;
    metadata?: {
      dimensions?: { width?: number; height?: number };
      lqip?: string;
    };
  };
}

export interface SiteSettings {
  title?: string;
  cover?: SanityImage;
  coverAlt?: string;
  tagline?: string;
  about?: string;
  socialLinks?: Array<{ label?: string; url?: string }>;
}

export interface GalleryIndexItem {
  _id: string;
  title: string;
  slug: string;
  cover?: {
    image?: SanityImage;
    alt?: string;
  };
}

export interface GalleryPhoto {
  _id: string;
  title?: string;
  image?: SanityImage;
  alt?: string;
  caption?: string;
}

export interface GalleryDetail {
  _id: string;
  title: string;
  slug: string;
  description?: string;
  photos?: GalleryPhoto[];
  exhibitions?: Exhibition[];
}

/** Older documents may predate the `required()` rules, so treat fields as optional. */
export interface Exhibition {
  _id: string;
  title?: string;
  description?: string;
  year?: string;
  location?: string;
  city?: string;
  country?: string;
}

export interface Publication {
  _id: string;
  title?: string;
  description?: string;
  year?: string;
}
