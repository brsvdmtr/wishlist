// Unit test — ImportOnboarding renders the 3-step URL-import empty-state
// explainer with localized copy. It replaces the bare "drafts_empty" label
// so a first-time user understands "Добавить товар по ссылке".

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { t, type Locale } from '@wishlist/shared';
import { ImportOnboarding } from './ImportOnboarding';

describe('ImportOnboarding', () => {
  it('renders the heading, sub, and all 3 numbered steps (RU)', () => {
    render(<ImportOnboarding locale="ru" />);

    expect(screen.getByText('Здесь пока пусто')).toBeInTheDocument();
    expect(screen.getByText('Добавь товар по ссылке — это пара секунд. Вот как:')).toBeInTheDocument();

    // numbered step circles
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();

    // step titles
    expect(screen.getByText('Скопируй ссылку на товар')).toBeInTheDocument();
    expect(screen.getByText('Вставь её в поле выше')).toBeInTheDocument();
    expect(screen.getByText('Дальше я сам')).toBeInTheDocument();

    // step 3 carries the "I will ask you to fill in" promise
    expect(
      screen.getByText('Соберу карточку: фото, название и цену. Что не распознаю — попрошу дописать'),
    ).toBeInTheDocument();
  });

  it('resolves localized copy — EN differs from RU', () => {
    render(<ImportOnboarding locale="en" />);

    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
    expect(screen.getByText('Copy a product link')).toBeInTheDocument();
    expect(screen.getByText('Paste it into the field above')).toBeInTheDocument();
    expect(screen.getByText('I will take it from there')).toBeInTheDocument();
  });

  it('renders every onboarding string in all 6 locales', () => {
    const locales: Locale[] = ['ru', 'en', 'zh-CN', 'hi', 'es', 'ar'];
    const keys = [
      'drafts_ob_title', 'drafts_ob_sub',
      'drafts_ob_s1_title', 'drafts_ob_s1_text',
      'drafts_ob_s2_title', 'drafts_ob_s2_text',
      'drafts_ob_s3_title', 'drafts_ob_s3_text',
    ] as const;
    for (const locale of locales) {
      const { unmount } = render(<ImportOnboarding locale={locale} />);
      for (const key of keys) {
        const value = t(key, locale);
        // real copy resolved, not a raw-key fallthrough; i18n.parity.test.ts owns key parity
        expect(value, `${key} unresolved for ${locale}`).not.toBe(key);
        expect(screen.getByText(value)).toBeInTheDocument();
      }
      unmount();
    }
  });
});
