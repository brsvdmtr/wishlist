'use client';

import Script from 'next/script';
import { useEffect } from 'react';

declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        ready: () => void;
        expand: () => void;
        enableClosingConfirmation?: (enable: boolean) => void;
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
