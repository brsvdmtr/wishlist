import './globals.css';
import type { Metadata } from 'next';
import { Rubik, Yeseva_One } from 'next/font/google';

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
      <body className="min-h-dvh font-sans">
        <div className="mx-auto max-w-5xl px-6 py-10">{children}</div>
      </body>
    </html>
  );
}
