import type { Metadata, Viewport } from 'next';
import Script from 'next/script';

export const metadata: Metadata = {
  title: 'WishBoard',
  description: 'Твой персональный вишлист',
  manifest: '/manifest.json',
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

      {/* Desktop: centered phone-frame with shadow. Mobile: full screen. */}
      <style>{`
        /* Reset parent layout padding for miniapp route */
        body { background: #06060e !important; overflow: hidden !important; }
        body > div { padding: 0 !important; margin: 0 !important; max-width: none !important; }
        .miniapp-shell { position: fixed; inset: 0; z-index: 1; }

        @media (min-width: 600px) {
          .miniapp-shell {
            /* Become a flex container that centers the phone frame */
            display: flex;
            align-items: center;
            justify-content: center;
            background: #06060e;
            /* Subtle radial glow behind the phone */
            background: radial-gradient(ellipse 600px 400px at 50% 40%, rgba(124,106,255,0.08), transparent 70%), #06060e;
          }
          .miniapp-phone {
            position: relative;
            width: 430px;
            height: min(92vh, 932px);
            border-radius: 32px;
            overflow: hidden;
            box-shadow:
              0 0 0 1px rgba(255,255,255,0.06),
              0 25px 80px rgba(0,0,0,0.5),
              0 0 60px rgba(124,106,255,0.08);
          }
          /* Override MiniApp's position:fixed to stay within the phone frame */
          .miniapp-phone > div { position: absolute !important; }
        }

        @media (max-width: 599px) {
          .miniapp-phone { position: fixed; inset: 0; }
          .miniapp-phone > div { position: fixed !important; }
        }
      `}</style>

      <div className="miniapp-shell">
        <div className="miniapp-phone">
          {children}
        </div>
      </div>
    </>
  );
}
