/* Shared bits for the calendar canvas: tiny Phone shell, header,
 * status bar, nav. Mirrors the conventions in ../index.html so screens
 * look identical to the live miniapp. */

const { useState } = React;

function Phone({ children, label }) {
  return (
    <div className="phone-wrap">
      <div className="wb-phone wb-app" data-theme="dark" data-accent="violet">
        <StatusBar />
        {children}
      </div>
      {label && <div className="phone-label">{label}</div>}
    </div>
  );
}
function StatusBar() {
  return (
    <div className="wb-status">
      <div>9:41</div>
      <div className="wb-status-icons"><span>•••</span><span>5G</span><span style={{marginLeft:4}}>◼</span></div>
    </div>
  );
}
function Header({ left, title, subtitle, right }) {
  return (
    <div className="wb-hdr">
      {left || <div style={{width:40}} />}
      <div style={{flex:1, textAlign:'center', overflow:'hidden'}}>
        <div className="wb-hdr-title">{title}</div>
        {subtitle && <div className="wb-hdr-sub">{subtitle}</div>}
      </div>
      {right || <div style={{width:40}} />}
    </div>
  );
}
function HeaderBtn({ icon, onClick }) {
  return <button className="wb-hdr-btn" onClick={onClick}>{icon}</button>;
}

function NavBar({ active = 'events' }) {
  const items = [
    { id: 'home',    ic: '☰', l: 'Лента' },
    { id: 'find',    ic: '⌕', l: 'Поиск' },
    { id: 'add',     ic: '＋', l: '' },
    { id: 'events',  ic: '◇', l: 'События' },
    { id: 'me',      ic: '○', l: 'Я' },
  ];
  return (
    <div className="wb-nav">
      {items.map(it => (
        <div key={it.id} className={`wb-nav-item ${active === it.id ? 'active' : ''}`}>
          <span className="wb-nav-ic">{it.ic}</span>
          {it.l && <span>{it.l}</span>}
        </div>
      ))}
    </div>
  );
}

/* tiny iconography — single-glyph symbols only (matches miniapp visual lang) */
const Glyph = {
  back: '‹',
  more: '⋯',
  close: '✕',
  add: '＋',
  filter: '⌖',
  share: '↗',
  bell: '◔',
  edit: '✎',
  star: '✦',
  link: '↗',
  check: '✓',
  copy: '⎘',
  loc: '◉',
  time: '◷',
  user: '○',
  users: '◉',
  gift: '◆',
  cake: '✧',
  cal: '▦',
  list: '☰',
  chevron: '›',
  chevronD: '⌄',
  star5: '⋆',
};

Object.assign(window, { Phone, StatusBar, Header, HeaderBtn, NavBar, Glyph });
