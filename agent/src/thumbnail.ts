import sharp from 'sharp';

const THUMBNAIL_MAX_DIMENSION = 400;
const THUMBNAIL_JPEG_QUALITY = 80;

/**
 * Thumbnails are stored upright: `.rotate()` applies the EXIF orientation and sharp drops the tag, so
 * a phone photo is not shown sideways. Thumbnails made before this change are still in the raw sensor
 * frame (see `boxFrame` in `scanFaces`).
 */
export async function generateThumbnail(filePath: string): Promise<Buffer> {
  return sharp(filePath)
    .rotate()
    .resize(THUMBNAIL_MAX_DIMENSION, THUMBNAIL_MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: THUMBNAIL_JPEG_QUALITY })
    .toBuffer();
}
