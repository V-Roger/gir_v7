/** Sanity image field shape (simplified for URL builder). */
export interface SanityImage {
  _type?: "image";
  asset?: {
    _id?: string;
    url?: string;
    _ref?: string;
    _type?: "reference";
  };
  metadata?: {
    dimensions?: {
      width?: number;
      height?: number;
    };
  };
}

export interface SiteSettings {
  title?: string;
  cover?: {
    image?: SanityImage;
    alt?: string;
  };
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
  exhibitions?: Exhibition[];
}

export interface Exhibition {
  _id: string;
  title: string;
  description?: string;
  year: string;
  location?: string;
  city?: string;
  country?: string;
}

export interface Publication {
  _id: string;
  title: string;
  description?: string;
  year: string;
}