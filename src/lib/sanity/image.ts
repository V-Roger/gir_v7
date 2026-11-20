import { createImageUrlBuilder } from "@sanity/image-url";
import { sanityClient } from "sanity:client";
import type { SanityImage } from "./types";

const builder = createImageUrlBuilder(sanityClient);

/** Candidate widths for responsive `srcset` (px). */
const DEFAULT_WIDTHS = [480, 800, 1200, 1600, 2000];

export interface ImageAttrs {
  src: string;
  srcset: string;
  sizes: string;
  width?: number;
  height?: number;
}

function buildUrl(image: SanityImage, width: number): string {
  return builder.image(image).width(width).fit("max").auto("format").url();
}

/** Rendered dimensions after applying the Studio crop (if any). */
function croppedDimensions(image: SanityImage): { width: number; height: number } | undefined {
  const dims = image.asset?.metadata?.dimensions;
  if (!dims?.width || !dims?.height) return undefined;
  const { top = 0, bottom = 0, left = 0, right = 0 } = image.crop ?? {};
  return {
    width: Math.round(dims.width * (1 - left - right)),
    height: Math.round(dims.height * (1 - top - bottom)),
  };
}

/**
 * Responsive `<img>` attributes for a Sanity image (served and resized by the Sanity CDN).
 * Never requests widths larger than the original asset.
 */
export function imageAttrs(
  image: SanityImage,
  { sizes = "100vw", widths = DEFAULT_WIDTHS }: { sizes?: string; widths?: number[] } = {},
): ImageAttrs {
  const dims = croppedDimensions(image);
  const maxWidth = dims?.width;
  const candidates = maxWidth ? widths.filter((w) => w < maxWidth) : widths;
  if (maxWidth) candidates.push(maxWidth);

  const largest = candidates[candidates.length - 1];
  // Default src: a mid-size variant for browsers without srcset support.
  const fallback = candidates.find((w) => w >= 1200) ?? largest;

  return {
    src: buildUrl(image, fallback),
    srcset: candidates.map((w) => `${buildUrl(image, w)} ${w}w`).join(", "),
    sizes,
    width: dims?.width,
    height: dims?.height,
  };
}
