/**
 * Token received from POST /auth/telegram after validating Telegram WebApp initData.
 * Stored in localStorage by /app page. Use for API requests: Authorization: Bearer <token>.
 */
export const AUTH_TOKEN_KEY = 'wishlist_telegram_token';

export function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getAuthHeaders(): Record<string, string> {
  const token = getStoredToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}
