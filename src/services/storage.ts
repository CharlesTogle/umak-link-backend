import { getSupabaseClient } from './supabase.js';
import logger from '../utils/logger.js';
import crypto from 'node:crypto';
import path from 'node:path';

const ITEMS_BUCKET = process.env.ITEMS_BUCKET || 'items';
const PROFILE_PICTURES_BUCKET = process.env.PROFILE_PICTURES_BUCKET || 'profilePictures';

export interface SignedUploadUrl {
  uploadUrl: string;
  objectPath: string;
  publicUrl: string;
}

export async function generateSignedUploadUrl(
  bucket: 'items' | 'profilePictures',
  fileName: string,
  contentType: string,
  _expiresIn: number = 3600
): Promise<SignedUploadUrl> {
  const supabase = getSupabaseClient();
  const bucketName = bucket === 'items' ? ITEMS_BUCKET : PROFILE_PICTURES_BUCKET;
  const ext = path.extname(fileName).toLowerCase();
  const safeExt =
    ext && ext.length <= 10 && /^[a-z0-9.]+$/.test(ext) ? ext : '';

  if (contentType !== 'image/webp' || safeExt !== '.webp') {
    logger.warn({ bucket, fileName, contentType }, 'Rejected non-webp upload');
    throw new Error('Only WebP uploads are allowed');
  }

  const objectPath = `${Date.now()}-${crypto.randomUUID()}${safeExt}`;

  const { data, error } = await supabase.storage
    .from(bucketName)
    .createSignedUploadUrl(objectPath, {
      upsert: false,
    });

  if (error) {
    logger.error({ error, bucket, fileName }, 'Failed to create signed upload URL');
    throw new Error('Failed to generate upload URL');
  }

  const publicUrl = supabase.storage.from(bucketName).getPublicUrl(objectPath).data.publicUrl;

  return {
    uploadUrl: data.signedUrl,
    objectPath,
    publicUrl,
  };
}

export async function confirmUpload(
  bucket: 'items' | 'profilePictures',
  objectPath: string
): Promise<{ publicUrl: string }> {
  const supabase = getSupabaseClient();
  const bucketName = bucket === 'items' ? ITEMS_BUCKET : PROFILE_PICTURES_BUCKET;

  // Verify the file exists
  const { data, error } = await supabase.storage.from(bucketName).list('', {
    search: objectPath,
  });

  if (error || !data || data.length === 0) {
    logger.error({ bucket, objectPath }, 'Upload confirmation failed - file not found');
    throw new Error('File not found');
  }

  const match = data.find((item) => item.name === objectPath);
  const mimeType = match?.metadata?.mimetype as string | undefined;
  if (!objectPath.toLowerCase().endsWith('.webp') || (mimeType && mimeType !== 'image/webp')) {
    logger.warn({ bucket, objectPath, mimeType }, 'Rejected non-webp upload on confirm');
    throw new Error('Only WebP uploads are allowed');
  }

  const publicUrl = supabase.storage.from(bucketName).getPublicUrl(objectPath).data.publicUrl;

  logger.info({ bucket, objectPath }, 'Upload confirmed');
  return { publicUrl };
}

export async function deleteStorageObject(
  bucket: 'items' | 'profilePictures',
  objectPath: string
): Promise<boolean> {
  const supabase = getSupabaseClient();
  const bucketName = bucket === 'items' ? ITEMS_BUCKET : PROFILE_PICTURES_BUCKET;

  const { error } = await supabase.storage.from(bucketName).remove([objectPath]);

  if (error) {
    logger.error({ error, bucket, objectPath }, 'Failed to delete storage object');
    return false;
  }

  logger.info({ bucket, objectPath }, 'Storage object deleted');
  return true;
}

export async function deleteItemImages(itemId: string): Promise<boolean> {
  const supabase = getSupabaseClient();

  // Get all images for this item
  const { data: images, error: fetchError } = await supabase
    .from('item_image_table')
    .select('image_url')
    .eq('item_id', itemId);

  if (fetchError) {
    logger.error({ error: fetchError, itemId }, 'Failed to fetch item images');
    return false;
  }

  if (!images || images.length === 0) {
    return true;
  }

  // Extract paths from URLs and delete
  const paths = images
    .map((img) => {
      const url = img.image_url;
      const match = url.match(/\/storage\/v1\/object\/public\/items\/(.+)$/);
      return match ? match[1] : null;
    })
    .filter(Boolean) as string[];

  if (paths.length > 0) {
    const { error: deleteError } = await supabase.storage.from(ITEMS_BUCKET).remove(paths);

    if (deleteError) {
      logger.error({ error: deleteError, itemId }, 'Failed to delete item images from storage');
      return false;
    }
  }

  logger.info({ itemId, count: paths.length }, 'Item images deleted');
  return true;
}
