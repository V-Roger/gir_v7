/** Sanity image field shape (simplified for URL builder). */
export interface SanityImage {
  _type?: "image";
  asset?: {
    _ref?: string;
    _type?: "reference";
  };
}

export interface SiteSettings {
  title?: string;
  tagline?: string;
  about?: string;
  socialLinks?: Array<{ label?: string; url?: string }>;
}

export interface GalleryIndexItem {
  _id: string;
  title: string;
  slug: string;
  description?: string;
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
  dateTaken?: string;
}

export interface GalleryDetail {
  _id: string;
  title: string;
  slug: string;
  description?: string;
  photos?: GalleryPhoto[];
}
