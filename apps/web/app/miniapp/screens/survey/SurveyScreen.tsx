// Mini App survey screen — renders the PMF discovery flow (Wave 1).
//
// Flow:
//   1. Mount → load the survey by inviteId (POST /by-invite/:inviteId).
//   2. If already COMPLETED → show completion view with the stored rewardKind.
//   3. Else render question N. Multi-choice questions enforce maxSelections.
//   4. Each "Next" tap saves the current question via POST /answer (so a mid-flow
//      close still preserves the per-question answer).
//   5. Q10 is optional. "Submit" on Q10 with text → save + complete. "Skip" → complete.
//   6. "Not now" → confirm sheet → POST /dismiss → onExit().
//
// State is local; the API is the source of truth (reload re-fetches progress).
// MAX_ANSWER_TEXT_LENGTH is duplicated from the API const for client-side bounds.

'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Sheet } from '@wishlist/ui';
import { getCopy, formatTemplate, type SurveyLocale, type SurveyCopy } from './copy';
import type { SurveyByInviteResponse, SurveyQuestionWire } from './types';
import { loadSurveyByInvite, postAnswer, postComplete, postDismiss, type TgFetch } from './api';

const MAX_ANSWER_TEXT_LENGTH = 500;

type Phase =
  | { kind: 'loading' }
  | { kind: 'load_error'; message: string }
  | { kind: 'closed' }
  | { kind: 'answering'; index: number }
  | { kind: 'submitting' }
  | { kind: 'completed'; rewardKind: 'pro_30d' | 'pro_30d_lifetime_noop' };

export interface SurveyScreenProps {
  inviteId: string;
  tgFetch: TgFetch;
  onExit: () => void;
  onCompleted?: () => void;
}

export function SurveyScreen({ inviteId, tgFetch, onExit, onCompleted }: SurveyScreenProps) {
  const [data, setData] = useState<SurveyByInviteResponse | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [textAnswer, setTextAnswer] = useState<string>('');
  const [dismissOpen, setDismissOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Locale fallback if data hasn't loaded yet — pick by browser hint.
  const localeFromData: SurveyLocale | null = data ? data.invite.locale : null;
  const copy: SurveyCopy = useMemo(
    () => getCopy(localeFromData ?? 'en'),
    [localeFromData],
  );

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: 'loading' });
    loadSurveyByInvite(tgFetch, inviteId)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        if (res.response && res.response.completedAt) {
          const k = (res.response.rewardKind === 'pro_30d_lifetime_noop'
            ? 'pro_30d_lifetime_noop'
            : 'pro_30d');
          setPhase({ kind: 'completed', rewardKind: k });
        } else {
          setPhase({ kind: 'answering', index: 0 });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'load failed';
        // 410 → survey closed (treat distinctly so we don't show "try again").
        if (message.includes('410') || message.includes('SURVEY_CLOSED')) {
          setPhase({ kind: 'closed' });
        } else {
          setPhase({ kind: 'load_error', message });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [inviteId, tgFetch]);

  const question: SurveyQuestionWire | null = useMemo(() => {
    if (!data || phase.kind !== 'answering') return null;
    return data.survey.questions[phase.index] ?? null;
  }, [data, phase]);

  const currentSelections = question ? selections[question.id] ?? [] : [];

  const toggleOption = useCallback(
    (optionId: string) => {
      if (!question) return;
      setSelections((prev) => {
        const cur = prev[question.id] ?? [];
        if (question.type === 'single' || question.type === 'nps') {
          return { ...prev, [question.id]: [optionId] };
        }
        if (question.type === 'open') return prev;
        // multi: toggle, enforce maxSelections cap
        if (cur.includes(optionId)) {
          return { ...prev, [question.id]: cur.filter((o) => o !== optionId) };
        }
        if (cur.length >= question.maxSelections) {
          // drop the first selection (FIFO) so user can swap without unticking
          return { ...prev, [question.id]: [...cur.slice(1), optionId] };
        }
        return { ...prev, [question.id]: [...cur, optionId] };
      });
    },
    [question],
  );

  const canAdvance = useMemo(() => {
    if (!question) return false;
    if (question.type === 'open') return true; // Q10 optional
    return currentSelections.length >= 1;
  }, [question, currentSelections]);

  const goBack = useCallback(() => {
    if (phase.kind !== 'answering') return;
    if (phase.index === 0) return;
    setPhase({ kind: 'answering', index: phase.index - 1 });
    setSaveError(null);
  }, [phase]);

  const handleNext = useCallback(async () => {
    if (!data || !question || phase.kind !== 'answering') return;
    setBusy(true);
    setSaveError(null);
    try {
      const isOpen = question.type === 'open';
      const selected = isOpen ? ['__text__'] : currentSelections;
      const text = isOpen && textAnswer.trim().length > 0 ? textAnswer.trim() : undefined;

      if (selected.length > 0) {
        await postAnswer(tgFetch, data.invite.surveyId, {
          inviteId: data.invite.id,
          questionId: question.id,
          selectedOptionIds: selected,
          ...(text ? { answerText: text } : {}),
        });
      }

      const isLast = phase.index >= data.survey.questions.length - 1;
      if (isLast) {
        setPhase({ kind: 'submitting' });
        const res = await postComplete(tgFetch, data.invite.surveyId, data.invite.id);
        setPhase({ kind: 'completed', rewardKind: res.rewardKind });
        onCompleted?.();
      } else {
        setPhase({ kind: 'answering', index: phase.index + 1 });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'save failed';
      setSaveError(msg);
    } finally {
      setBusy(false);
    }
  }, [data, question, phase, currentSelections, textAnswer, tgFetch, onCompleted]);

  const handleSkipQ10 = useCallback(async () => {
    if (!data || !question || phase.kind !== 'answering') return;
    if (question.type !== 'open') return;
    setBusy(true);
    setSaveError(null);
    setPhase({ kind: 'submitting' });
    try {
      const res = await postComplete(tgFetch, data.invite.surveyId, data.invite.id);
      setPhase({ kind: 'completed', rewardKind: res.rewardKind });
      onCompleted?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'submit failed';
      setSaveError(msg);
      setPhase({ kind: 'answering', index: phase.index });
    } finally {
      setBusy(false);
    }
  }, [data, question, phase, tgFetch, onCompleted]);

  const handleDismissConfirm = useCallback(async () => {
    if (!data) return;
    setBusy(true);
    try {
      await postDismiss(tgFetch, data.invite.surveyId, data.invite.id);
    } catch {
      // Best-effort — proceed to exit regardless. The server will treat as
      // abandonment if we couldn't write DISMISSED.
    } finally {
      setBusy(false);
      setDismissOpen(false);
      onExit();
    }
  }, [data, tgFetch, onExit]);

  // ─── Render variants ───
  const wrapStyle: React.CSSProperties = {
    minHeight: '100%',
    background: 'var(--wb-bg)',
    color: 'var(--wb-text)',
    padding: '16px 16px calc(120px + env(safe-area-inset-bottom))',
    boxSizing: 'border-box',
  };

  if (phase.kind === 'loading') {
    return (
      <div style={wrapStyle}>
        <p style={{ textAlign: 'center', marginTop: 60, color: 'var(--wb-text-secondary)' }}>{copy.loading}</p>
      </div>
    );
  }
  if (phase.kind === 'load_error') {
    return (
      <div style={wrapStyle}>
        <p style={{ textAlign: 'center', marginTop: 60 }}>{copy.loadError}</p>
        <div style={{ marginTop: 24, textAlign: 'center' }}>
          <Button onClick={onExit} variant="secondary">{copy.btn.dismiss}</Button>
        </div>
      </div>
    );
  }
  if (phase.kind === 'closed') {
    return (
      <div style={wrapStyle}>
        <p style={{ textAlign: 'center', marginTop: 60 }}>{copy.surveyClosed}</p>
        <div style={{ marginTop: 24, textAlign: 'center' }}>
          <Button onClick={onExit} variant="primary">{copy.completion.pro30d.btn}</Button>
        </div>
      </div>
    );
  }
  if (phase.kind === 'completed') {
    const v = phase.rewardKind === 'pro_30d_lifetime_noop' ? copy.completion.lifetime : copy.completion.pro30d;
    return (
      <div style={wrapStyle}>
        <div style={{ marginTop: 60, textAlign: 'center' }}>
          <div style={{ fontSize: 56, marginBottom: 16 }}>🎉</div>
          <h2 style={{ margin: '0 0 8px', fontSize: 22 }}>{v.title}</h2>
          <p style={{ color: 'var(--wb-text-secondary)', lineHeight: 1.5 }}>{v.subtitle}</p>
          <div style={{ marginTop: 32 }}>
            <Button onClick={onExit} variant="primary" size="lg">{v.btn}</Button>
          </div>
        </div>
      </div>
    );
  }
  if (phase.kind === 'submitting') {
    return (
      <div style={wrapStyle}>
        <p style={{ textAlign: 'center', marginTop: 60, color: 'var(--wb-text-secondary)' }}>{copy.loading}</p>
      </div>
    );
  }

  // phase.kind === 'answering'
  if (!data || !question) {
    return <div style={wrapStyle} />;
  }
  const total = data.survey.questions.length;
  const isLast = phase.index >= total - 1;
  const isOpen = question.type === 'open';

  return (
    <div style={wrapStyle}>
      {/* Header — progress + close (not-now) */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ color: 'var(--wb-text-secondary)', fontSize: 14 }}>
          {formatTemplate(copy.progress, { n: phase.index + 1, total })}
        </span>
        <button
          onClick={() => setDismissOpen(true)}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--wb-text-secondary)',
            fontSize: 14,
            cursor: 'pointer',
            padding: '8px 12px',
            minWidth: 44,
            minHeight: 44,
          }}
        >
          {copy.btn.dismiss}
        </button>
      </div>

      <Card variant="default" padding="lg">
        <h2 style={{ margin: '0 0 16px', fontSize: 18, lineHeight: 1.4 }}>
          {copy.q[question.id]?.title ?? question.id}
        </h2>
        {question.type === 'multi' && (
          <p style={{ color: 'var(--wb-text-secondary)', fontSize: 13, margin: '0 0 12px' }}>
            {formatTemplate(copy.multiHint, { max: question.maxSelections })}
          </p>
        )}
        {question.type === 'nps' && (
          <p style={{ color: 'var(--wb-text-secondary)', fontSize: 13, margin: '0 0 12px' }}>
            {copy.q[question.id]?.hint ?? copy.npsHint}
          </p>
        )}

        {isOpen ? (
          <OpenAnswer
            value={textAnswer}
            onChange={setTextAnswer}
            placeholder={copy.q[question.id]?.placeholder ?? ''}
            charCounterTemplate={copy.q[question.id]?.charCounter ?? '{{count}} / 500'}
          />
        ) : question.type === 'nps' ? (
          <NpsGrid
            value={currentSelections[0]}
            options={question.options}
            onPick={toggleOption}
          />
        ) : (
          <OptionList
            options={question.options}
            labels={copy.q[question.id]?.options ?? {}}
            selected={currentSelections}
            onToggle={toggleOption}
          />
        )}
      </Card>

      {saveError && (
        <p style={{ color: 'var(--wb-text-error, #f87171)', fontSize: 13, marginTop: 12, textAlign: 'center' }}>
          {copy.saveError}
        </p>
      )}

      <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
        {phase.index > 0 && (
          <Button variant="secondary" onClick={goBack} disabled={busy}>
            {copy.btn.back}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        {isOpen && (
          <Button variant="secondary" onClick={handleSkipQ10} disabled={busy}>
            {copy.btn.skip}
          </Button>
        )}
        <Button
          variant="primary"
          onClick={handleNext}
          disabled={busy || !canAdvance}
        >
          {isLast ? copy.btn.submit : copy.btn.next}
        </Button>
      </div>

      <Sheet open={dismissOpen} onClose={() => setDismissOpen(false)} title={copy.dismiss.title}>
        <p style={{ color: 'var(--wb-text-secondary)', lineHeight: 1.5, margin: '0 0 24px' }}>
          {copy.dismiss.body}
        </p>
        <div style={{ display: 'flex', gap: 12 }}>
          <Button
            variant="secondary"
            onClick={() => setDismissOpen(false)}
            disabled={busy}
            style={{ flex: 1 }}
          >
            {copy.dismiss.cancel}
          </Button>
          <Button
            variant="primary"
            onClick={handleDismissConfirm}
            disabled={busy}
            style={{ flex: 1 }}
          >
            {copy.dismiss.confirm}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function OptionList({
  options,
  labels,
  selected,
  onToggle,
}: {
  options: readonly string[];
  labels: Record<string, string>;
  selected: string[];
  onToggle: (optionId: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {options.map((optionId) => {
        const isOn = selected.includes(optionId);
        return (
          <button
            key={optionId}
            onClick={() => onToggle(optionId)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '14px 16px',
              border: isOn ? '1.5px solid var(--wb-accent)' : '1px solid var(--wb-border)',
              borderRadius: 12,
              background: isOn ? 'var(--wb-accent-soft, rgba(140,127,255,0.08))' : 'var(--wb-bg-elevated)',
              color: 'var(--wb-text)',
              fontSize: 15,
              textAlign: 'left',
              cursor: 'pointer',
              minHeight: 48,
              transition: 'border-color 120ms ease, background 120ms ease',
            }}
          >
            <span aria-hidden style={{
              display: 'inline-block', width: 18, height: 18, borderRadius: 9,
              border: '1.5px solid ' + (isOn ? 'var(--wb-accent)' : 'var(--wb-border)'),
              background: isOn ? 'var(--wb-accent)' : 'transparent',
              flexShrink: 0,
            }} />
            <span>{labels[optionId] ?? optionId}</span>
          </button>
        );
      })}
    </div>
  );
}

function NpsGrid({
  value,
  options,
  onPick,
}: {
  value: string | undefined;
  options: readonly string[];
  onPick: (optionId: string) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
      {options.map((optionId) => {
        const score = optionId.replace('score_', '');
        const isOn = value === optionId;
        return (
          <button
            key={optionId}
            onClick={() => onPick(optionId)}
            style={{
              padding: '14px 0',
              minHeight: 48,
              borderRadius: 12,
              border: isOn ? '1.5px solid var(--wb-accent)' : '1px solid var(--wb-border)',
              background: isOn ? 'var(--wb-accent)' : 'var(--wb-bg-elevated)',
              color: isOn ? 'var(--wb-on-accent, #fff)' : 'var(--wb-text)',
              fontWeight: 600,
              fontSize: 16,
              cursor: 'pointer',
            }}
          >
            {score}
          </button>
        );
      })}
    </div>
  );
}

function OpenAnswer({
  value,
  onChange,
  placeholder,
  charCounterTemplate,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  charCounterTemplate: string;
}) {
  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => {
          const next = e.target.value.slice(0, MAX_ANSWER_TEXT_LENGTH);
          onChange(next);
        }}
        placeholder={placeholder}
        rows={5}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: 12,
          borderRadius: 12,
          border: '1px solid var(--wb-border)',
          background: 'var(--wb-bg-elevated)',
          color: 'var(--wb-text)',
          fontSize: 15,
          fontFamily: 'inherit',
          resize: 'vertical',
          minHeight: 100,
        }}
      />
      <p style={{ color: 'var(--wb-text-secondary)', fontSize: 12, margin: '6px 4px 0', textAlign: 'right' }}>
        {formatTemplate(charCounterTemplate, { count: value.length })}
      </p>
    </div>
  );
}
