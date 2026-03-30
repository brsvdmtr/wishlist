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

      <style>{`
        /* Reset parent layout padding for miniapp route */
        body { background: #08081a !important; overflow: hidden !important; }
        body > div { padding: 0 !important; margin: 0 !important; max-width: none !important; }
        .miniapp-shell { position: fixed; inset: 0; z-index: 1; }

        /* ── Mobile: full screen, no chrome ── */
        @media (max-width: 767px) {
          .miniapp-desktop-side { display: none !important; }
          .miniapp-phone { position: fixed; inset: 0; }
          .miniapp-phone > div { position: fixed !important; }
        }

        /* ── Desktop: split layout ── */
        @media (min-width: 768px) {
          .miniapp-shell {
            display: flex;
            align-items: stretch;
            background:
              radial-gradient(ellipse 800px 600px at 30% 50%, rgba(124,106,255,0.06), transparent 70%),
              #08081a;
          }

          /* Left side — branding */
          .miniapp-desktop-side {
            flex: 1;
            display: flex;
            flex-direction: column;
            justify-content: center;
            padding: 60px;
            max-width: 560px;
            min-width: 320px;
          }
          .miniapp-desktop-side .brand-logo {
            font-size: 32px;
            font-weight: 800;
            color: #fff;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 12px;
          }
          .miniapp-desktop-side .brand-logo span {
            background: linear-gradient(135deg, #7C6AFF, #A78BFA);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
          }
          .miniapp-desktop-side .brand-tagline {
            font-size: 18px;
            color: rgba(255,255,255,0.5);
            line-height: 1.6;
            margin-bottom: 40px;
          }
          .miniapp-desktop-side .brand-features {
            display: flex;
            flex-direction: column;
            gap: 16px;
          }
          .miniapp-desktop-side .brand-feature {
            display: flex;
            align-items: center;
            gap: 14px;
            color: rgba(255,255,255,0.7);
            font-size: 15px;
          }
          .miniapp-desktop-side .brand-feature-icon {
            width: 40px;
            height: 40px;
            border-radius: 12px;
            background: rgba(124,106,255,0.1);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            flex-shrink: 0;
          }
          .miniapp-desktop-side .brand-footer {
            margin-top: 48px;
            font-size: 12px;
            color: rgba(255,255,255,0.2);
          }
          .miniapp-desktop-side .brand-footer a {
            color: rgba(124,106,255,0.5);
            text-decoration: none;
          }
          .miniapp-desktop-side .brand-footer a:hover {
            color: rgba(124,106,255,0.8);
          }

          /* Right side — phone frame */
          .miniapp-phone-wrap {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
          }
          .miniapp-phone {
            position: relative;
            width: 390px;
            height: min(94vh, 844px);
            border-radius: 44px;
            overflow: hidden;
            background: #0a0a14;
            box-shadow:
              0 0 0 1px rgba(255,255,255,0.08),
              0 0 0 4px rgba(255,255,255,0.02),
              0 30px 100px rgba(0,0,0,0.6),
              0 0 80px rgba(124,106,255,0.06);
          }
          /* Subtle notch indicator */
          .miniapp-phone::before {
            content: '';
            position: absolute;
            top: 0;
            left: 50%;
            transform: translateX(-50%);
            width: 120px;
            height: 28px;
            background: #08081a;
            border-radius: 0 0 18px 18px;
            z-index: 10;
          }
          /* Override MiniApp's position:fixed to stay within the phone frame */
          .miniapp-phone > div { position: absolute !important; }
        }

        /* Wide desktop: more generous layout */
        @media (min-width: 1200px) {
          .miniapp-desktop-side {
            padding: 80px;
            max-width: 640px;
          }
        }
      `}</style>

      <div className="miniapp-shell">
        {/* Left: Desktop branding panel */}
        <div className="miniapp-desktop-side">
          <div className="brand-logo">
            <span>WishBoard</span>
          </div>
          <div className="brand-tagline">
            Создавай вишлисты, делись с друзьями.<br />
            Подарки без спойлеров.
          </div>
          <div className="brand-features">
            <div className="brand-feature">
              <div className="brand-feature-icon">&#x1F4CB;</div>
              <div>Организуй желания в удобные списки</div>
            </div>
            <div className="brand-feature">
              <div className="brand-feature-icon">&#x1F517;</div>
              <div>Делись одной ссылкой с кем угодно</div>
            </div>
            <div className="brand-feature">
              <div className="brand-feature-icon">&#x1F381;</div>
              <div>Друзья бронируют подарки приватно</div>
            </div>
            <div className="brand-feature">
              <div className="brand-feature-icon">&#x1F91D;</div>
              <div>Тайный Санта с автоматическим распределением</div>
            </div>
          </div>
          <div className="brand-footer">
            <a href="https://t.me/WishHub_bot" target="_blank" rel="noopener">Telegram Bot</a>
          </div>
        </div>

        {/* Right: Phone frame */}
        <div className="miniapp-phone-wrap">
          <div className="miniapp-phone">
            {children}
          </div>
        </div>
      </div>
    </>
  );
}
