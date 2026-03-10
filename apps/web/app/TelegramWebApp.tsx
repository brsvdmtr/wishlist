'use client';

import Script from 'next/script';
import { useEffect } from 'react';

type TgWebAppUser = { id: number; first_name: string; last_name?: string; username?: string };

declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        ready(): void;
        expand(): void;
        close(): void;
        initData: string;
        initDataUnsafe: { user?: TgWebAppUser; start_param?: string };
        setHeaderColor(color: string): void;
        setBackgroundColor(color: string): void;
        colorScheme: 'light' | 'dark';
        enableClosingConfirmation?: (enable: boolean) => void;
        BackButton: { show(): void; hide(): void; onClick(fn: () => void): void; offClick(fn: () => void): void };
        HapticFeedback: {
          impactOccurred(style: 'light' | 'medium' | 'heavy'): void;
          notificationOccurred(type: 'error' | 'success' | 'warning'): void;
        };
        openTelegramLink(url: string): void;
        openLink(url: string, options?: { try_instant_view?: boolean }): void;
        openInvoice?(url: string, callback?: (status: string) => void): void;
      };
    };
  }
}

/**
 * Подключает Telegram Web App API и разворачивает контент на весь экран при открытии из кнопки меню бота (модалка).
 * На десктопе модалка уже открыта на полный экран; на мобильных expand() раскрывает нижнюю панель.
 */
export default function TelegramWebApp() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const tw = window.Telegram?.WebApp;
    if (!tw) return;
    tw.ready();
    tw.expand();
  }, []);

  return (
    <Script
      src="https://telegram.org/js/telegram-web-app.js"
      strategy="afterInteractive"
      onLoad={() => {
        window.Telegram?.WebApp?.ready();
        window.Telegram?.WebApp?.expand();
      }}
    />
  );
}
