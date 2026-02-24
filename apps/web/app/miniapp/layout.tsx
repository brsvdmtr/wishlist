import type { Metadata } from 'next';
import Script from 'next/script';

export const metadata: Metadata = {
  title: 'WishBoard',
  description: 'Твой персональный вишлист',
};

export default function MiniAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Telegram WebApp SDK must load before React hydrates */}
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
      {children}
    </>
  );
}
