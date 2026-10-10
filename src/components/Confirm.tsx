'use client';

import { useEffect, useRef } from 'react';
import { haptic } from '@/lib/device';

/**
 * A yes/no the user actually has to mean.
 *
 * Not window.confirm(): that renders a browser chrome dialog that looks like a
 * scam warning, cannot be styled, and on Android appears welded to the top of
 * the screen far from the thumb that triggered it.
 *
 * The cautious choice is focused when it opens and Escape takes it, so the
 * reflex action is always the safe one. The destructive button is the one you
 * have to aim at.
 */
export function Confirm({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    cancelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
      // Keep Tab inside the dialog — otherwise focus walks off onto the page
      // behind it, which for a screen reader is the same as the dialog not
      // being there at all.
      if (e.key !== 'Tab') return;
      const items = panelRef.current?.querySelectorAll<HTMLElement>('button');
      if (!items?.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    document.addEventListener('keydown', onKey);
    // The page behind must not scroll under the dialog.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="cf-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        ref={panelRef}
        className="cf-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cf-title"
      >
        <h2 className="cf-title" id="cf-title">{title}</h2>
        {body && <div className="cf-body">{body}</div>}
        <div className="cf-actions">
          <button
            ref={cancelRef}
            className="btn cf-btn"
            onClick={() => { haptic('tick'); onCancel(); }}
          >
            {cancelLabel}
          </button>
          <button
            className="btn cf-btn"
            data-primary={!danger ? 'true' : undefined}
            data-danger={danger ? 'true' : undefined}
            onClick={() => { haptic('alert'); onConfirm(); }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
