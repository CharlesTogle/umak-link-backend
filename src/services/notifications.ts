import admin from 'firebase-admin';
import logger from '../utils/logger.js';
import { getSupabaseClient } from './supabase.js';
import { PUSH_NOTIFICATION_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';
import { getPhilippineNowIso } from '../utils/time.js';

let firebaseInitialized = false;

interface FirebaseServiceAccount {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
  universe_domain?: string;
}

function validateServiceAccount(obj: unknown): obj is FirebaseServiceAccount {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const account = obj as Record<string, unknown>;
  const requiredFields = ['type', 'project_id', 'private_key', 'client_email'];
  const missingFields = requiredFields.filter((field) => !account[field] || typeof account[field] !== 'string');

  if (missingFields.length > 0) {
    logger.error(
      { missingFields },
      'Firebase service account is missing required fields. Check your FIREBASE_SERVICE_ACCOUNT environment variable.'
    );
    return false;
  }

  // Validate private_key format (should start with -----BEGIN PRIVATE KEY-----)
  const privateKey = account.private_key as string;
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    logger.error(
      'Firebase service account private_key is invalid. It should contain "-----BEGIN PRIVATE KEY-----"'
    );
    return false;
  }

  return true;
}

function initializeFirebase(): void {
  if (firebaseInitialized) return;

  const serviceAccountEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountEnv) {
    logger.warn('FIREBASE_SERVICE_ACCOUNT not configured - push notifications disabled');
    return;
  }

  try {
    // Parse the JSON string
    let serviceAccount: unknown;
    try {
      serviceAccount = JSON.parse(serviceAccountEnv);
    } catch (parseError) {
      logger.error(
        { error: parseError },
        'Failed to parse FIREBASE_SERVICE_ACCOUNT as JSON. Ensure it is a valid JSON string.'
      );
      return;
    }

    // Validate the service account structure
    if (!validateServiceAccount(serviceAccount)) {
      logger.error(
        'Invalid Firebase service account format. Required fields: type, project_id, private_key, client_email. ' +
        'Get your service account JSON from Firebase Console > Project Settings > Service Accounts > Generate New Private Key'
      );
      return;
    }

    // Initialize Firebase Admin
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
    });

    firebaseInitialized = true;
    logger.info({ projectId: serviceAccount.project_id }, 'Firebase Admin initialized successfully');
  } catch (error) {
    logger.error(
      { error },
      'Failed to initialize Firebase Admin. Verify your service account credentials are correct.'
    );
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
  image_id?: number | null;
  global_announcement_id?: number | null;
  skip_push?: boolean;
}

type SupabaseErrorLike = {
  code?: string;
  message?: string;
};

type NotificationRecipientRole = 'User' | 'Staff' | 'Admin';

function serializeNotificationDataValue(value: unknown): unknown {
  if (value == null) return value;

  if (Array.isArray(value)) {
    return JSON.stringify(value.map((entry) => (entry == null ? '' : String(entry))));
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return value;
}

function normalizeNotificationData(
  data?: Record<string, unknown> | null
): Record<string, unknown> | undefined {
  if (!data) return undefined;

  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      if (key === 'postId' || key === 'post_id') {
        if (typeof value === 'string' || typeof value === 'number') {
          return [key, String(value)];
        }
      }

      if (key === 'matched_post_ids' || key === 'post_ids') {
        if (typeof value === 'string') {
          return [key, value];
        }

        return [key, serializeNotificationDataValue(value)];
      }

      return [key, serializeNotificationDataValue(value)];
    })
  );
}

function serializeFcmDataValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return '';

  if (Array.isArray(value) || typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function isMissingColumnError(error: unknown, column: string): boolean {
  const typed = error as SupabaseErrorLike | null;
  if (!typed) return false;
  return typed.code === 'PGRST204' && typeof typed.message === 'string' && typed.message.includes(`'${column}'`);
}

function isNotificationRecipientRole(value: unknown): value is NotificationRecipientRole {
  return value === 'User' || value === 'Staff' || value === 'Admin';
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

function getNotificationsPathForRole(role: NotificationRecipientRole): string {
  if (role === 'Staff') return '/staff/notifications';
  if (role === 'Admin') return '/admin/notifications';
  return '/user/notifications';
}

function getPostPathForRole(role: NotificationRecipientRole, postId: string): string {
  if (role === 'Staff') return `/staff/post-record/view/${postId}`;
  if (role === 'Admin') return '/admin/notifications';
  return `/user/post/view/${postId}`;
}

function getNotificationUrl(
  type: string,
  data?: Record<string, unknown>,
  role: NotificationRecipientRole = 'User'
): string | null {
  if (data?.link && typeof data.link === 'string') return data.link;
  if (data?.href && typeof data.href === 'string') return data.href;
  if (data?.url && typeof data.url === 'string') return data.url;

  const postId = data?.postId ?? data?.post_id;
  const normalizedPostId =
    typeof postId === 'string' || typeof postId === 'number' ? String(postId) : null;

  switch (type) {
    case 'global_announcement':
      return null;
    case 'match':
      return normalizedPostId ? getPostPathForRole(role, normalizedPostId) : getNotificationsPathForRole(role);
    case 'accept':
    case 'post_accepted':
      return normalizedPostId ? getPostPathForRole(role, normalizedPostId) : getNotificationsPathForRole(role);
    default:
      return getNotificationsPathForRole(role);
  }
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
    const normalizedData = normalizeNotificationData(payload.data);
    const resolvedUrl = getNotificationUrl(payload.type, normalizedData);
    const message: admin.messaging.Message = {
      token,
      notification: {
        title: payload.title,
        body: payload.body,
        imageUrl: payload.image_url || undefined,
      },
      data: {
        type: payload.type,
        ...(resolvedUrl
          ? { url: resolvedUrl }
          : {}),
        ...Object.fromEntries(
          Object.entries(normalizedData || {}).map(([key, value]) => [
            key,
            serializeFcmDataValue(value),
          ])
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
      PUSH_NOTIFICATION_TIMEOUT_MS,
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
    const imageId =
      payload.image_id ?? (await createNotificationImageId(payload.image_url));
    const createdAt = getPhilippineNowIso();
    const { data: userData, error: userLookupError } = await supabase
      .from('user_table')
      .select('notification_token, user_type')
      .eq('user_id', payload.user_id)
      .single();

    if (userLookupError) {
      logger.warn({ error: userLookupError, userId: payload.user_id }, 'Failed to fetch notification recipient metadata');
    }

    const recipientRole = isNotificationRecipientRole(userData?.user_type)
      ? userData.user_type
      : 'User';
    const normalizedData = normalizeNotificationData(payload.data);
    const resolvedUrl = getNotificationUrl(payload.type, normalizedData, recipientRole);
    const notificationData = {
      ...(normalizedData || {}),
      ...(resolvedUrl ? { url: resolvedUrl } : {}),
    };

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
        data: notificationData,
        is_read: false,
        ...(payload.global_announcement_id
          ? { global_announcement_id: payload.global_announcement_id }
          : {}),
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
          data: notificationData,
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

    if (!payload.skip_push) {
      if (userData?.notification_token) {
        await sendPushNotification(userData.notification_token, {
          ...payload,
          data: notificationData,
        });
      }
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

    // Create image record if imageUrl is provided
    let imageId: number | null = null;
    if (imageUrl) {
      const { data: imageData, error: imageError } = await supabase
        .from('notification_image_table')
        .insert({
          image_url: imageUrl,
          created_at: createdAt,
        })
        .select('image_id')
        .single();

      if (imageError) {
        logger.warn({ error: imageError }, 'Failed to persist announcement image');
      } else {
        imageId = imageData?.image_id ?? null;
      }
    }

    // Create announcement record
    const { data: announcement, error: announcementError } = await supabase
      .from('global_announcements_table')
      .insert({
        created_at: createdAt,
        message,
        description,
        image_id: imageId,
        sent_by: senderId,
      })
      .select()
      .single();

    if (announcementError) {
      logger.error({ error: announcementError }, 'Failed to create announcement');
      return false;
    }

    const announcementId = announcement.id as number | undefined;
    if (!announcementId) {
      logger.error({ announcement }, 'Announcement insert did not return an ID');
      return false;
    }

    // Create in-app notifications for every user so announcements appear in the portal.
    const { data: users, error: usersError } = await supabase
      .from('user_table')
      .select('user_id, notification_token, user_type')
      .not('user_id', 'is', null);

    if (usersError) {
      logger.error({ error: usersError }, 'Failed to fetch users for announcement');
      return false;
    }

    const recipientUsers = (users || []).filter((user) => user.user_id && user.user_id !== senderId);

    const createNotificationPromises = recipientUsers.map((user) =>
      createNotification({
        user_id: user.user_id,
        title: 'Announcement',
        body: message,
        description,
        type: 'global_announcement',
        image_url: imageUrl,
        image_id: imageId,
        sent_by: senderId,
        global_announcement_id: announcementId,
        data: { announcement_id: announcementId },
        skip_push: true,
      })
    );

    await Promise.allSettled(createNotificationPromises);

    const sendPromises = recipientUsers
      .filter((u) => u.notification_token)
      .map((user) =>
        sendPushNotification(user.notification_token!, {
          user_id: user.user_id,
          title: 'Announcement',
          body: message,
          description,
          type: 'global_announcement',
          image_url: imageUrl,
          data: {
            announcement_id: announcementId,
            ...(isNotificationRecipientRole(user.user_type)
              ? { url: getNotificationsPathForRole(user.user_type) }
              : {}),
          },
        })
      );

    await Promise.allSettled(sendPromises);
    logger.info({
      announcementId,
      recipientCount: recipientUsers.length,
      excludedSenderId: senderId,
    }, 'Global announcement sent');

    return true;
  } catch (error) {
    logger.error({ error }, 'Error in sendGlobalAnnouncement');
    return false;
  }
}
