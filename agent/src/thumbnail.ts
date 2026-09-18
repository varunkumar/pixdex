import sharp from 'sharp';

const THUMBNAIL_MAX_DIMENSION = 400;
const THUMBNAIL_JPEG_QUALITY = 80;

export async function generateThumbnail(filePath: string): Promise<Buffer> {
  return sharp(filePath)
    .resize(THUMBNAIL_MAX_DIMENSION, THUMBNAIL_MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: THUMBNAIL_JPEG_QUALITY })
    .toBuffer();
}
