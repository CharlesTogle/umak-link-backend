import admin from 'firebase-admin';
import logger from '../utils/logger.js';
import { getSupabaseClient } from './supabase.js';
import { DEFAULT_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';
import { getPhilippineNowIso } from '../utils/time.js';

let firebaseInitialized = false;

function initializeFirebase(): void {
  if (firebaseInitialized) return;

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccount) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(serviceAccount)),
      });
      firebaseInitialized = true;
      logger.info('Firebase Admin initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize Firebase Admin');
    }
  } else {
    logger.warn('FIREBASE_SERVICE_ACCOUNT not configured - push notifications disabled');
  }
}

export interface NotificationPayload {
  user_id: string;
  title: string;
  body: string;
  description?: string | null;
  type: string;
  data?: Record<string, unknown>;
  image_url?: string | null;
  sent_by?: string | null;
}

type SupabaseErrorLike = {
  code?: string;
  message?: string;
};

function isMissingColumnError(error: unknown, column: string): boolean {
  const typed = error as SupabaseErrorLike | null;
  if (!typed) return false;
  return typed.code === 'PGRST204' && typeof typed.message === 'string' && typed.message.includes(`'${column}'`);
}

async function createNotificationImageId(
  imageUrl: string | null | undefined
): Promise<number | null> {
  if (!imageUrl) return null;

  const supabase = getSupabaseClient();
  const createdAt = getPhilippineNowIso();
  const { data, error } = await supabase
    .from('notification_image_table')
    .insert({
      image_url: imageUrl,
      created_at: createdAt,
    })
    .select('image_id')
    .single();

  if (error) {
    logger.warn({ error }, 'Failed to persist notification image');
    return null;
  }

  return data?.image_id ?? null;
}

export async function sendPushNotification(
  token: string,
  payload: NotificationPayload
): Promise<boolean> {
  initializeFirebase();

  if (!firebaseInitialized) {
    logger.warn('Push notification skipped - Firebase not initialized');
    return false;
  }

  try {
    const message: admin.messaging.Message = {
      token,
      notification: {
        title: payload.title,
        body: payload.body,
        imageUrl: payload.image_url || undefined,
      },
      data: {
        type: payload.type,
        ...Object.fromEntries(
          Object.entries(payload.data || {}).map(([k, v]) => [k, String(v)])
        ),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'default',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    await withTimeout(
      admin.messaging().send(message),
      DEFAULT_TIMEOUT_MS,
      'Firebase send'
    );
    logger.info({ userId: payload.user_id, type: payload.type }, 'Push notification sent');
    return true;
  } catch (error) {
    logger.error({ error, userId: payload.user_id }, 'Failed to send push notification');
    return false;
  }
}

export async function createNotification(payload: NotificationPayload): Promise<string | number | null> {
  const supabase = getSupabaseClient();

  try {
    const imageId = await createNotificationImageId(payload.image_url);
    const createdAt = getPhilippineNowIso();

    const canonicalInsert = await supabase
      .from('notification_table')
      .insert({
        notification_id: crypto.randomUUID(),
        created_at: createdAt,
        title: payload.title,
        description: payload.description ?? payload.body,
        sent_to: payload.user_id,
        sent_by: payload.sent_by ?? null,
        type: payload.type,
        data: payload.data || {},
        is_read: false,
        ...(imageId ? { image_id: imageId } : {}),
      })
      .select('notification_id')
      .single();

    let notificationId: string | number | null = canonicalInsert.data?.notification_id ?? null;

    if (canonicalInsert.error) {
      const shouldFallback =
        isMissingColumnError(canonicalInsert.error, 'sent_to') ||
        isMissingColumnError(canonicalInsert.error, 'description');

      if (!shouldFallback) {
        logger.error({ error: canonicalInsert.error }, 'Failed to create notification in database');
        return null;
      }

      // Backward-compatible fallback for older schemas using user_id/body.
      const legacyInsert = await supabase
        .from('notification_table')
        .insert({
          created_at: createdAt,
          user_id: payload.user_id,
          title: payload.title,
          body: payload.body,
          description: payload.description,
          type: payload.type,
          data: payload.data || {},
          is_read: false,
          ...(payload.image_url ? { image_url: payload.image_url } : {}),
        })
        .select('notification_id')
        .single();

      if (legacyInsert.error) {
        logger.error({ error: legacyInsert.error }, 'Failed to create notification in fallback schema');
        return null;
      }

      notificationId = legacyInsert.data?.notification_id ?? null;
    }

    // Get user's notification token and send push
    const { data: userData } = await supabase
      .from('user_table')
      .select('notification_token')
      .eq('user_id', payload.user_id)
      .single();

    if (userData?.notification_token) {
      await sendPushNotification(userData.notification_token, payload);
    }

    return notificationId;
  } catch (error) {
    logger.error({ error }, 'Error in createNotification');
    return null;
  }
}

export async function sendGlobalAnnouncement(
  message: string,
  description: string | null,
  imageUrl: string | null,
  senderId: string
): Promise<boolean> {
  const supabase = getSupabaseClient();

  try {
    const createdAt = getPhilippineNowIso();
    // Create announcement record
    const { data: announcement, error: announcementError } = await supabase
      .from('global_announcements_table')
      .insert({
        created_at: createdAt,
        message,
        description,
        image_url: imageUrl,
        created_by: senderId,
      })
      .select()
      .single();

    if (announcementError) {
      logger.error({ error: announcementError }, 'Failed to create announcement');
      return false;
    }

    // Get all users with notification tokens
    const { data: users, error: usersError } = await supabase
      .from('user_table')
      .select('user_id, notification_token')
      .not('notification_token', 'is', null);

    if (usersError) {
      logger.error({ error: usersError }, 'Failed to fetch users for announcement');
      return false;
    }

    // Send to all users
    const sendPromises = (users || [])
      .filter((u) => u.notification_token)
      .map((user) =>
        sendPushNotification(user.notification_token!, {
          user_id: user.user_id,
          title: 'Announcement',
          body: message,
          description,
          type: 'announcement',
          image_url: imageUrl,
          data: { announcement_id: announcement.global_notification_id },
        })
      );

    await Promise.allSettled(sendPromises);
    logger.info({
      announcementId: announcement.global_notification_id,
      recipientCount: users?.length || 0,
    }, 'Global announcement sent');

    return true;
  } catch (error) {
    logger.error({ error }, 'Error in sendGlobalAnnouncement');
    return false;
  }
}
