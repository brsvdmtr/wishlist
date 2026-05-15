import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UserAvatar } from './UserAvatar';

describe('UserAvatar', () => {
  it('renders first uppercase initial of name when no avatarUrl', () => {
    render(<UserAvatar name="Алексей" size={40} accent="#7C6AFF" />);
    expect(screen.getByText('А')).toBeInTheDocument();
  });

  it('uppercases lowercase initial', () => {
    render(<UserAvatar name="anna" size={40} accent="#7C6AFF" />);
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('trims whitespace before extracting the initial', () => {
    render(<UserAvatar name="   Bob   " size={40} accent="#7C6AFF" />);
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it('falls back to ? when name is null/undefined/empty', () => {
    const { rerender } = render(<UserAvatar name={null} size={40} accent="#7C6AFF" />);
    expect(screen.getByText('?')).toBeInTheDocument();
    rerender(<UserAvatar name={undefined} size={40} accent="#7C6AFF" />);
    expect(screen.getByText('?')).toBeInTheDocument();
    rerender(<UserAvatar name="" size={40} accent="#7C6AFF" />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('falls back to ? when name is whitespace-only', () => {
    render(<UserAvatar name="   " size={40} accent="#7C6AFF" />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('with avatarUrl: does NOT render the initial text', () => {
    const { container } = render(
      <UserAvatar avatarUrl="https://x.com/a.jpg" name="Anna" size={40} accent="#7C6AFF" />
    );
    const div = container.firstChild as HTMLElement;
    expect(div.textContent).toBe('');
  });

  it('with avatarUrl: sets backgroundImage with url(...)', () => {
    const { container } = render(
      <UserAvatar avatarUrl="https://x.com/a.jpg" name="A" size={40} accent="#7C6AFF" />
    );
    const div = container.firstChild as HTMLElement;
    expect(div.style.backgroundImage).toContain('url(');
    expect(div.style.backgroundImage).toContain('https://x.com/a.jpg');
  });

  it('font size is ~42% of avatar size', () => {
    const { container } = render(<UserAvatar name="A" size={100} accent="#7C6AFF" />);
    const div = container.firstChild as HTMLElement;
    expect(div.style.fontSize).toBe('42px');
  });

  it('honours border prop when provided', () => {
    const { container } = render(<UserAvatar name="A" size={40} accent="#000" border="2px solid red" />);
    const div = container.firstChild as HTMLElement;
    expect(div.style.border).toBe('2px solid red');
  });

  it('hat={true} wraps avatar in relative container + adds SVG overlay', () => {
    const { container } = render(<UserAvatar name="A" size={40} accent="#000" hat />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.position).toBe('relative');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('hat={false} default — no SVG overlay', () => {
    const { container } = render(<UserAvatar name="A" size={40} accent="#000" />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('extra style override merges over defaults (last write wins via spread)', () => {
    const { container } = render(<UserAvatar name="A" size={40} accent="#000" style={{ opacity: 0.5, fontSize: 99 }} />);
    const div = container.firstChild as HTMLElement;
    expect(div.style.opacity).toBe('0.5');
    expect(div.style.fontSize).toBe('99px');
  });
});
