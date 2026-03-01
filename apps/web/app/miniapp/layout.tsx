import type { Metadata, Viewport } from 'next';
import Script from 'next/script';

export const metadata: Metadata = {
  title: 'WishBoard',
  description: 'Твой персональный вишлист',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function MiniAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Telegram WebApp SDK must load before React hydrates */}
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="afterInteractive" />
      {children}
    </>
  );
}
