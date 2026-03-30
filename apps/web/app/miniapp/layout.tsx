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
        /* ── Reset parent layout chrome for miniapp ── */
        body {
          background: #0a0a14 !important;
          overflow: hidden !important;
          margin: 0 !important;
        }
        body > div {
          padding: 0 !important;
          margin: 0 !important;
          max-width: none !important;
        }

        /* ── Mobile: full screen, no desktop chrome ── */
        @media (max-width: 767px) {
          .wb-desktop-sidebar { display: none !important; }
          .wb-desktop-topbar { display: none !important; }
          .wb-app-container { position: fixed; inset: 0; }
          .wb-app-container > div { position: fixed !important; }
        }

        /* ── Desktop layout ── */
        @media (min-width: 768px) {
          .wb-layout {
            display: flex;
            height: 100vh;
            overflow: hidden;
          }

          /* Sidebar */
          .wb-desktop-sidebar {
            width: 240px;
            flex-shrink: 0;
            background: #0d0d1a;
            border-right: 1px solid rgba(255,255,255,0.06);
            display: flex;
            flex-direction: column;
            padding: 0;
            overflow-y: auto;
          }
          .wb-sidebar-logo {
            padding: 24px 20px 20px;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .wb-sidebar-logo h1 {
            font-size: 20px;
            font-weight: 800;
            margin: 0;
            background: linear-gradient(135deg, #7C6AFF, #A78BFA);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
          }
          .wb-sidebar-nav {
            flex: 1;
            padding: 8px 10px;
            display: flex;
            flex-direction: column;
            gap: 2px;
          }
          .wb-nav-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 12px;
            border-radius: 10px;
            color: rgba(255,255,255,0.5);
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            border: none;
            background: none;
            width: 100%;
            text-align: left;
            font-family: inherit;
            transition: all 0.15s;
          }
          .wb-nav-item:hover {
            background: rgba(255,255,255,0.04);
            color: rgba(255,255,255,0.8);
          }
          .wb-nav-item.active {
            background: rgba(124,106,255,0.1);
            color: #A78BFA;
          }
          .wb-nav-item .nav-icon {
            width: 20px;
            text-align: center;
            font-size: 16px;
            flex-shrink: 0;
          }
          .wb-nav-section {
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 0.8px;
            text-transform: uppercase;
            color: rgba(255,255,255,0.2);
            padding: 16px 12px 6px;
          }
          .wb-sidebar-footer {
            padding: 16px 12px;
            border-top: 1px solid rgba(255,255,255,0.06);
          }
          .wb-sidebar-footer a {
            font-size: 12px;
            color: rgba(255,255,255,0.25);
            text-decoration: none;
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .wb-sidebar-footer a:hover {
            color: rgba(255,255,255,0.4);
          }

          /* Main content area */
          .wb-main {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
          }

          /* Top bar */
          .wb-desktop-topbar {
            height: 56px;
            flex-shrink: 0;
            background: #0d0d1a;
            border-bottom: 1px solid rgba(255,255,255,0.06);
            display: flex;
            align-items: center;
            justify-content: flex-end;
            padding: 0 24px;
            gap: 12px;
          }
          .wb-topbar-user {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            color: rgba(255,255,255,0.6);
          }
          .wb-topbar-avatar {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: rgba(124,106,255,0.15);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            color: #A78BFA;
            font-weight: 600;
          }

          /* App container — MiniApp renders here */
          .wb-app-container {
            flex: 1;
            position: relative;
            overflow: hidden;
          }
          /* Override MiniApp's position:fixed → absolute within container */
          .wb-app-container > div {
            position: absolute !important;
            border-radius: 0 !important;
          }
        }

        /* Wide desktop: wider sidebar */
        @media (min-width: 1200px) {
          .wb-desktop-sidebar { width: 260px; }
        }
      `}</style>

      <div className="wb-layout">
        {/* Desktop Sidebar */}
        <aside className="wb-desktop-sidebar">
          <div className="wb-sidebar-logo">
            <span style={{ fontSize: 24 }}>&#x1F381;</span>
            <h1>WishBoard</h1>
          </div>

          <nav className="wb-sidebar-nav">
            <div className="wb-nav-section">Основное</div>
            <button className="wb-nav-item active" data-screen="my-wishlists"
              onClick={() => window.dispatchEvent(new CustomEvent('wb-navigate', { detail: 'my-wishlists' }))}>
              <span className="nav-icon">&#x1F4CB;</span> Мои вишлисты
            </button>
            <button className="wb-nav-item" data-screen="my-reservations"
              onClick={() => window.dispatchEvent(new CustomEvent('wb-navigate', { detail: 'my-reservations' }))}>
              <span className="nav-icon">&#x1F516;</span> Мои брони
            </button>
            <button className="wb-nav-item" data-screen="gift-notes"
              onClick={() => window.dispatchEvent(new CustomEvent('wb-navigate', { detail: 'gift-notes' }))}>
              <span className="nav-icon">&#x1F381;</span> Поводы и идеи
            </button>

            <div className="wb-nav-section">Социальное</div>
            <button className="wb-nav-item" data-screen="santa-hub"
              onClick={() => window.dispatchEvent(new CustomEvent('wb-navigate', { detail: 'santa-hub' }))}>
              <span className="nav-icon">&#x1F385;</span> Тайный Санта
            </button>

            <div className="wb-nav-section">Настройки</div>
            <button className="wb-nav-item" data-screen="profile"
              onClick={() => window.dispatchEvent(new CustomEvent('wb-navigate', { detail: 'profile' }))}>
              <span className="nav-icon">&#x1F464;</span> Профиль
            </button>
            <button className="wb-nav-item" data-screen="settings"
              onClick={() => window.dispatchEvent(new CustomEvent('wb-navigate', { detail: 'settings' }))}>
              <span className="nav-icon">&#x2699;&#xFE0F;</span> Настройки
            </button>
          </nav>

          <div className="wb-sidebar-footer">
            <a href="https://t.me/WishHub_bot" target="_blank" rel="noopener">
              <span>&#x2708;&#xFE0F;</span> Telegram Bot
            </a>
          </div>
        </aside>

        {/* Main area */}
        <div className="wb-main">
          {/* Top bar */}
          <header className="wb-desktop-topbar">
            <div className="wb-topbar-user" id="wb-topbar-user">
              {/* Filled by MiniApp via DOM when user data loads */}
            </div>
          </header>

          {/* App content */}
          <div className="wb-app-container">
            {children}
          </div>
        </div>
      </div>
    </>
  );
}
