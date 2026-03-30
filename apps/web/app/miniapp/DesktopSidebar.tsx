'use client';

type NavSection = { kind: 'section'; label: string };
type NavLink = { kind: 'link'; screen: string; icon: string; label: string };
type NavItem = NavSection | NavLink;

const navItems: NavItem[] = [
  { kind: 'section', label: 'Основное' },
  { kind: 'link', screen: 'my-wishlists', icon: '\u{1F4CB}', label: 'Мои вишлисты' },
  { kind: 'link', screen: 'my-reservations', icon: '\u{1F516}', label: 'Мои брони' },
  { kind: 'link', screen: 'gift-notes', icon: '\u{1F381}', label: 'Поводы и идеи' },
  { kind: 'section', label: 'Социальное' },
  { kind: 'link', screen: 'santa-hub', icon: '\u{1F385}', label: 'Тайный Санта' },
  { kind: 'section', label: 'Настройки' },
  { kind: 'link', screen: 'profile', icon: '\u{1F464}', label: 'Профиль' },
  { kind: 'link', screen: 'settings', icon: '\u2699\uFE0F', label: 'Настройки' },
];

export default function DesktopSidebar() {
  return (
    <aside className="wb-desktop-sidebar">
      <div className="wb-sidebar-logo">
        <span style={{ fontSize: 24 }}>&#x1F381;</span>
        <h1>WishBoard</h1>
      </div>

      <nav className="wb-sidebar-nav">
        {navItems.map((item, i) => {
          if (item.kind === 'section') {
            return <div key={i} className="wb-nav-section">{item.label}</div>;
          }
          return (
            <button
              key={item.screen}
              className="wb-nav-item"
              data-screen={item.screen}
              onClick={() => window.dispatchEvent(new CustomEvent('wb-navigate', { detail: item.screen }))}
            >
              <span className="nav-icon">{item.icon}</span> {item.label}
            </button>
          );
        })}
      </nav>

      <div className="wb-sidebar-footer">
        <a href="https://t.me/WishHub_bot" target="_blank" rel="noopener">
          <span>&#x2708;&#xFE0F;</span> Telegram Bot
        </a>
      </div>
    </aside>
  );
}
