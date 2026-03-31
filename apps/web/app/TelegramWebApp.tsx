import Script from 'next/script';

type TgWebAppUser = { id: number; first_name: string; last_name?: string; username?: string; language_code?: string };

declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        ready(): void;
        expand(): void;
        close(): void;
        initData: string;
        version: string;
        platform: string;
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
        disableVerticalSwipes?(): void;
        enableVerticalSwipes?(): void;
        writeToClipboard?(text: string): void;
      };
    };
  }
}

/**
 * Loads the Telegram Web App SDK script before React hydration.
 * strategy="beforeInteractive" ensures window.Telegram is available
 * by the time any client component mounts.
 * ready() and expand() are called from MiniApp.tsx after init.
 */
export default function TelegramWebApp() {
  return (
    <Script
      src="https://telegram.org/js/telegram-web-app.js"
      strategy="beforeInteractive"
    />
  );
}
