import './globals.css';
import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
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
        {/*
          Stale-HTML guard. Next.js standalone removes old static chunks on
          every rebuild — when a deploy ships, anyone whose Telegram WebView
          (or browser) is still holding cached HTML from the previous build
          will request chunk URLs that no longer exist on origin. Some 404
          straight, some 200 from a stale CF edge cache (until that ages
          out), producing intermittent "Mini App виснет" reports. React's
          error boundary doesn't catch <script>/<link> load failures —
          those fire `error` on the element, never bubble through React.
          We install a capturing window listener that detects a failed
          /_next/static/ asset and triggers a single full reload to refetch
          fresh HTML. sessionStorage prevents an infinite loop if origin
          itself is broken; the `load` listener re-arms the guard for the
          next deploy. See docs/BUGFIX_LESSONS.md (2026-05-27).
        */}
        <Script id="wb-stale-chunk-reload" strategy="beforeInteractive">{`
(function(){
  var KEY='__wb_stale_chunk_reload';
  window.addEventListener('error', function(e){
    var t=e&&e.target;
    if(!t||(t.tagName!=='SCRIPT'&&t.tagName!=='LINK'))return;
    var src=t.src||t.href||'';
    if(src.indexOf('/_next/static/')<0)return;
    try{
      if(sessionStorage.getItem(KEY))return;
      sessionStorage.setItem(KEY,String(Date.now()));
    }catch(_){}
    try{location.reload();}catch(_){}
  },true);
  window.addEventListener('load',function(){
    try{sessionStorage.removeItem(KEY);}catch(_){}
  });
})();
        `}</Script>
        <TelegramWebApp />
        <div className="mx-auto min-w-0 max-w-5xl px-4 py-6 sm:px-6 sm:py-10">{children}</div>
      </body>
    </html>
  );
}
