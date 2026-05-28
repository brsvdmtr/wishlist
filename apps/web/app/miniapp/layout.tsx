import type { Metadata, Viewport } from 'next';
import Script from 'next/script';

export const metadata: Metadata = {
  title: 'WishBoard',
  description: 'Твой персональный вишлист — список желаний в Telegram',
  // Privacy: every external subresource (item images, gift-occasion idea
  // images, etc.) loads with no Referer header. Without this, an attacker
  // could host an image at `https://attacker.example/track.gif`, set it
  // as an item URL inside a wishlist, and harvest the Referer of every
  // guest who views that wishlist (= the WishBoard share-link / public
  // profile URL, which itself may carry identifiers). `no-referrer`
  // strips the header entirely for all subresources rendered on this
  // route — applies to <img>, CSS background-image, fetch, etc.
  // IP-level leakage (the viewer's IP still hits the attacker host) is
  // a separate concern; closing that requires a server-side image
  // proxy, which is deferred.
  referrer: 'no-referrer',
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
      <Script
        id="telegram-webapp-sdk"
        src="https://telegram.org/js/telegram-web-app.js"
        strategy="afterInteractive"
      />
      {children}
    </>
  );
}
