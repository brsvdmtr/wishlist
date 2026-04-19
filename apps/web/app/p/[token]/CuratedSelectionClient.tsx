'use client';

import React from 'react';
import {
  colors,
  fontSize,
  fontWeight,
  fontFamily,
  radius,
  spacing,
  lineHeight,
} from '@wishlist/ui-tokens';
import { ListRow } from '@wishlist/ui';

type CuratedItem = {
  id: string;
  title: string;
  priceText: string | null;
  currency: string;
  imageUrl: string | null;
};

type SelectionData = {
  selection: {
    id: string;
    title: string;
    itemCount: number;
    expiresAt: string;
    items: CuratedItem[];
  };
};

const currencySymbols: Record<string, string> = {
  RUB: '₽', USD: '$', EUR: '€', GBP: '£',
};

function formatPrice(priceText: string | null, currency: string) {
  if (!priceText) return null;
  const sym = currencySymbols[currency] ?? currency;
  return `${priceText} ${sym}`;
}

export default function CuratedSelectionClient({
  expired,
  data,
  token,
}: {
  expired: boolean;
  data: SelectionData | { error: string; expiresAt?: string };
  token: string;
}) {
  const botLink = `https://t.me/WishBoardBot?start=cs_${token}`;

  if (expired) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: colors.bg,
          color: colors.text,
          fontFamily: fontFamily.sans,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacing[8],
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 80,
            height: 80,
            borderRadius: radius.xxxl,
            background: colors.warningSoft,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: fontSize.hero,
            marginBottom: spacing[6],
          }}
        >
          ⏱️
        </div>
        <h1
          style={{
            fontSize: fontSize.display,
            fontWeight: fontWeight.extrabold,
            margin: `0 0 ${spacing[3]}px`,
          }}
        >
          Срок действия истёк
        </h1>
        <p
          style={{
            fontSize: fontSize.lg,
            color: colors.textSecondary,
            lineHeight: lineHeight.loose,
            maxWidth: 320,
          }}
        >
          Эта подборка была доступна 45 дней. Попросите отправителя создать новую.
        </p>
        <a
          href="https://t.me/WishBoardBot"
          style={{
            marginTop: spacing[8],
            padding: '14px 28px',
            borderRadius: radius.xl,
            background: colors.accent,
            color: colors.white,
            textDecoration: 'none',
            fontSize: fontSize.lg,
            fontWeight: fontWeight.semibold,
          }}
        >
          Создать свой вишлист
        </a>
      </div>
    );
  }

  const { selection } = data as SelectionData;
  const previewItems = selection.items.slice(0, 3);
  const moreCount = selection.itemCount - previewItems.length;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: colors.bg,
        color: colors.text,
        fontFamily: fontFamily.sans,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Hero */}
      <div style={{ padding: `48px ${spacing[6]}px ${spacing[6]}px`, textAlign: 'center' }}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: radius.xxxl,
            background: colors.accentSoft,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: fontSize.hero,
            margin: `0 auto ${spacing[5]}px`,
          }}
        >
          📋
        </div>
        <div
          style={{
            display: 'inline-block',
            padding: `${spacing[1]}px ${spacing[3]}px`,
            borderRadius: radius.md,
            background: colors.accentSoft,
            color: colors.accent,
            fontSize: fontSize.sm,
            fontWeight: fontWeight.semibold,
            marginBottom: spacing[3],
          }}
        >
          WishBoard
        </div>
        <h1
          style={{
            fontSize: fontSize.display,
            fontWeight: fontWeight.extrabold,
            margin: `0 0 ${spacing[2]}px`,
            lineHeight: lineHeight.snug,
          }}
        >
          {selection.title}
        </h1>
        <p
          style={{
            fontSize: fontSize.lg,
            color: colors.textSecondary,
            margin: 0,
          }}
        >
          {selection.itemCount}{' '}
          {selection.itemCount === 1
            ? 'желание'
            : selection.itemCount < 5
              ? 'желания'
              : 'желаний'}
        </p>
      </div>

      {/* CTA Button */}
      <div style={{ padding: `0 ${spacing[6]}px` }}>
        <a
          href={botLink}
          style={{
            display: 'block',
            padding: `${spacing[4]}px 0`,
            borderRadius: radius.xl,
            background: colors.accent,
            color: colors.white,
            textDecoration: 'none',
            fontSize: fontSize.xl,
            fontWeight: fontWeight.bold,
            textAlign: 'center',
          }}
        >
          Открыть в Telegram
        </a>
      </div>

      {/* Mini preview — ListRow adoption */}
      <div style={{ padding: `${spacing[6]}px ${spacing[6]}px 0` }}>
        <div
          style={{
            fontSize: fontSize.base,
            color: colors.textMuted,
            marginBottom: spacing[3],
            fontWeight: fontWeight.semibold,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          Превью
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[2] }}>
          {previewItems.map((item) => (
            <ListRow
              key={item.id}
              variant="compact"
              leading={
                item.imageUrl ? (
                  <img
                    src={item.imageUrl}
                    alt=""
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: radius.md,
                      objectFit: 'cover',
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: radius.md,
                      background: colors.accentSoft,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: fontSize.xl,
                    }}
                  >
                    🎁
                  </div>
                )
              }
              title={item.title}
              meta={
                item.priceText ? (
                  <span
                    style={{
                      fontSize: fontSize.base,
                      color: colors.accent,
                      fontWeight: fontWeight.semibold,
                    }}
                  >
                    {formatPrice(item.priceText, item.currency)}
                  </span>
                ) : undefined
              }
            />
          ))}
        </div>
        {moreCount > 0 && (
          <div
            style={{
              textAlign: 'center',
              padding: `${spacing[3]}px 0`,
              fontSize: fontSize.md,
              color: colors.textMuted,
            }}
          >
            и ещё {moreCount}...
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ flex: 1 }} />
      <div style={{ padding: spacing[6], textAlign: 'center' }}>
        <div
          style={{
            fontSize: fontSize.base,
            color: colors.textMuted,
            lineHeight: lineHeight.loose,
            marginBottom: spacing[4],
          }}
        >
          Откройте в Telegram, чтобы просмотреть все желания, сохранить подборку и создать свой вишлист
        </div>
        <a
          href={botLink}
          style={{
            display: 'block',
            padding: `${spacing[3.5]}px 0`,
            borderRadius: radius.xl,
            background: colors.surface,
            color: colors.accent,
            textDecoration: 'none',
            fontSize: fontSize.lg,
            fontWeight: fontWeight.semibold,
            border: `1px solid ${colors.border}`,
          }}
        >
          Открыть в Telegram
        </a>
      </div>
    </div>
  );
}
