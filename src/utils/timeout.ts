const FALLBACK_GENERAL_TIMEOUT_MS = parseInt(process.env.OUTBOUND_TIMEOUT_MS || '8000', 10);

export const GENERAL_TIMEOUT_MS = parseInt(
  process.env.GENERAL_TIMEOUT_MS || String(FALLBACK_GENERAL_TIMEOUT_MS),
  10
);
export const DATABASE_TIMEOUT_MS = parseInt(process.env.DATABASE_TIMEOUT_MS || '9500', 10);
export const AUDIT_TIMEOUT_MS = parseInt(process.env.AUDIT_TIMEOUT_MS || '5000', 10);
export const PUSH_NOTIFICATION_TIMEOUT_MS = parseInt(
  process.env.PUSH_NOTIFICATION_TIMEOUT_MS || '5000',
  10
);

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
