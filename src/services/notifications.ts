import admin from 'firebase-admin';
import logger from '../utils/logger.js';
import { getSupabaseClient } from './supabase.js';

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

    await admin.messaging().send(message);
    logger.info({ userId: payload.user_id, type: payload.type }, 'Push notification sent');
    return true;
  } catch (error) {
    logger.error({ error, userId: payload.user_id }, 'Failed to send push notification');
    return false;
  }
}

export async function createNotification(payload: NotificationPayload): Promise<number | null> {
  const supabase = getSupabaseClient();

  try {
    const { data, error } = await supabase
      .from('notification_table')
      .insert({
        user_id: payload.user_id,
        title: payload.title,
        body: payload.body,
        description: payload.description,
        type: payload.type,
        is_read: false,
      })
      .select('notification_id')
      .single();

    if (error) {
      logger.error({ error }, 'Failed to create notification in database');
      return null;
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

    return data.notification_id;
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
    // Create announcement record
    const { data: announcement, error: announcementError } = await supabase
      .from('global_announcements_table')
      .insert({
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
