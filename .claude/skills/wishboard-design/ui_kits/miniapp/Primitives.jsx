/* global React */
/*
 * WishBoard — primitive components for the Mini App UI kit.
 * Each is small, dumb, and mirrors packages/ui primitives (Button/Card/ListRow/…).
 * Exported to `window` at the bottom so screens can use them across <script> boundaries.
 */
const { useState } = React;

/* ─── Phone frame ─── */
function Phone({ children, label }) {
  return (
    <div className="wb-phone wb-app">
      {label && <div style={{position:'absolute',top:14,left:'50%',transform:'translateX(-50%)',background:'rgba(0,0,0,0.7)',color:'#fff',fontSize:10,padding:'4px 10px',borderRadius:100,fontWeight:700,letterSpacing:0.5,textTransform:'uppercase',zIndex:20,backdropFilter:'blur(8px)'}}>{label}</div>}
      <StatusBar />
      {children}
    </div>
  );
}

function StatusBar() {
  return (
    <div className="wb-status">
      <div>9:41</div>
      <div className="wb-status-icons">
        <span>􀙇</span><span>5G</span><span style={{marginLeft:4}}>􀛨</span>
      </div>
    </div>
  );
}

/* ─── Header ─── */
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

/* ─── Tabs ─── */
function Tabs({ items, active, onSelect }) {
  return (
    <div className="wb-tabs">
      {items.map(it => (
        <div key={it.id} className={`wb-tab ${active === it.id ? 'active' : ''}`} onClick={() => onSelect(it.id)}>
          {it.label}
          {it.badge && <span className="wb-tab-badge">{it.badge}</span>}
        </div>
      ))}
    </div>
  );
}

/* ─── Stat tile row ─── */
function StatRow({ stats }) {
  return (
    <div className="wb-stats">
      {stats.map((s, i) => (
        <div key={i} className={`wb-stat ${s.tone || ''}`}>
          <div className="wb-stat-n">{s.n}</div>
          <div className="wb-stat-l">{s.l}</div>
        </div>
      ))}
    </div>
  );
}

/* ─── Section header ─── */
function SectionHeader({ title, action }) {
  return (
    <div className="wb-section-hdr">
      <h2>{title}</h2>
      {action && <span className="wb-link" onClick={action.onClick}>{action.label}</span>}
    </div>
  );
}

/* ─── Chip / Button ─── */
function Chip({ tone = 'accent', children }) {
  return <span className={`wb-chip ${tone}`}>{children}</span>;
}

function Button({ variant = 'primary', children, onClick, style }) {
  return <button className={`wb-btn ${variant}`} onClick={onClick} style={style}>{children}</button>;
}

/* ─── Avatar stack ─── */
function AvatarStack({ people = [], extra = 0 }) {
  const grads = ['g1','g2','g3','g4','g5'];
  return (
    <div className="wb-stack">
      {people.map((p, i) => (
        <div key={i} className={`wb-av ${grads[i % grads.length]}`}>{p}</div>
      ))}
      {extra > 0 && <div className="wb-av plus">+{extra}</div>}
    </div>
  );
}

/* ─── Banner ─── */
function Banner({ tone = 'info', icon, children }) {
  return (
    <div className={`wb-banner ${tone}`}>
      <div className="wb-banner-ic">{icon}</div>
      <div style={{flex:1}}>{children}</div>
    </div>
  );
}

/* ─── Bottom nav ─── */
function BottomNav({ active, onSelect }) {
  const items = [
    { id: 'home', ic: '🏠', label: 'Главная' },
    { id: 'friends', ic: '👥', label: 'Друзья' },
    { id: 'reservations', ic: '🎁', label: 'Брони' },
    { id: 'me', ic: '👤', label: 'Я' },
  ];
  return (
    <div className="wb-nav">
      {items.map(it => (
        <div key={it.id} className={`wb-nav-item ${active === it.id ? 'active' : ''}`} onClick={() => onSelect(it.id)}>
          <div className="wb-nav-ic">{it.ic}</div>
          <div>{it.label}</div>
        </div>
      ))}
    </div>
  );
}

/* ─── Fab ─── */
function Fab({ onClick, icon = '+' }) {
  return <button className="wb-fab" onClick={onClick}>{icon}</button>;
}

/* ─── Sheet ─── */
function Sheet({ open, onClose, title, subtitle, children }) {
  return (
    <>
      <div className={`wb-sheet-backdrop ${open ? 'open' : ''}`} onClick={onClose} />
      <div className={`wb-sheet ${open ? 'open' : ''}`}>
        <div className="wb-sheet-handle" />
        {title && <div className="wb-sheet-title">{title}</div>}
        {subtitle && <div className="wb-sheet-sub">{subtitle}</div>}
        {children}
      </div>
    </>
  );
}

Object.assign(window, {
  Phone, StatusBar, Header, HeaderBtn, Tabs, StatRow,
  SectionHeader, Chip, Button, AvatarStack, Banner,
  BottomNav, Fab, Sheet
});
