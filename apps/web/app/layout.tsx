import './globals.css';
import type { Metadata, Viewport } from 'next';
import { Rubik, Yeseva_One } from 'next/font/google';
import TelegramWebApp from './TelegramWebApp';

const fontSans = Rubik({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-sans',
  display: 'swap',
});
const fontDisplay = Yeseva_One({
  subsets: ['latin', 'cyrillic'],
  weight: '400',
  variable: '--font-display',
  display: 'swap',
});

function safeUrl(value: string | undefined, fallback: string) {
  try {
    return new URL(value ?? fallback);
  } catch {
    return new URL(fallback);
  }
}

const siteUrl = safeUrl(process.env.NEXT_PUBLIC_SITE_URL, 'http://localhost:3000');

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: {
    default: 'WishList',
    template: '%s | WishList',
  },
  description: 'Public wishlists with simple reservation flow.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${fontSans.variable} ${fontDisplay.variable}`}>
      <body className="min-h-dvh font-sans overflow-x-hidden">
        <TelegramWebApp />
        <div className="mx-auto min-w-0 max-w-5xl px-4 py-6 sm:px-6 sm:py-10">{children}</div>
      </body>
    </html>
  );
}
