"use client";

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { ClipboardEvent, CSSProperties, KeyboardEvent } from "react";
import {
  NBSP,
  ZWSP,
  adjacentPill,
  caretBesidePill,
  ensurePillBoundaries,
  insertPillAtCaret,
  insertTextAtCaret,
  pillToDeleteBackward,
  reassertPills,
  removePill,
  replaceBeforeCaret,
  serializeHost,
  setHostContent,
  snapCaretOutOfPill,
  textBeforeCaret,
  markPillPrecedence,
  pillBeforeCaret,
  untightenedSpaceAfterPill,
} from "@/lib/pill-editor";

export interface PillEditorHandle {
  focus(): void;
  clear(): void;
  isEmpty(): boolean;
  getValue(): string;
  setValue(text: string): void;
  getTextBeforeCaret(): string;
  hasPillBeforeCaret(): boolean;
  replaceBeforeCaret(count: number, text: string): void;
  insertPill(skill: string): void;
  insertText(text: string): void;
}

export interface PillEditorProps {
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  maxHeight?: number;
  className?: string;
  style?: CSSProperties;
  onValueChange: (value: string) => void;
  onCaretChange: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onCompositionStateChange?: (composing: boolean) => void;
  pillTitles?: { expands: string; literal: string };
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}

/**
 * Uncontrolled by design. The browser owns the host's children; React only
 * seeds them once and overwrites them through `setValue`. Re-rendering the
 * children from state would destroy the caret on every keystroke.
 */
function PillEditor(
  {
    defaultValue,
    placeholder,
    disabled = false,
    maxHeight = 200,
    className,
    style,
    onValueChange,
    onCaretChange,
    onKeyDown,
    onCompositionStateChange,
    pillTitles,
    onPaste,
    onFocus,
    onBlur,
  }: PillEditorProps,
  ref: React.ForwardedRef<PillEditorHandle>,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const savedRange = useRef<Range | null>(null);
  const seed = useRef(defaultValue);
  const caretListener = useRef(onCaretChange);
  const composing = useRef(false);

  useEffect(() => {
    caretListener.current = onCaretChange;
  });

  const sync = (host: HTMLDivElement) => {
    markPillPrecedence(host, pillTitles);
    host.dataset.empty = String((host.textContent ?? "").replaceAll(ZWSP, "") === "");
    onValueChange(serializeHost(host));
  };

  /**
   * Put the caret back where the user left it before an imperative insert.
   * The live caret wins over the saved one: engines fire selectionchange
   * asynchronously, so a range saved during fast typing lags several
   * characters behind and would drop the insert mid-word.
   */
  const restoreCaret = () => {
    const host = hostRef.current;
    const selection = window.getSelection();
    if (!host || !selection) return null;
    const live = selection.rangeCount ? selection.getRangeAt(0) : null;
    const saved = savedRange.current;
    let target: Range | null = null;
    if (live && live.collapsed && host.contains(live.startContainer)) target = live.cloneRange();
    else if (saved && host.contains(saved.startContainer)) target = saved;
    host.focus();
    if (!target) {
      target = document.createRange();
      target.selectNodeContents(host);
      target.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(target);
    return host;
  };

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (seed.current) setHostContent(host, seed.current);
    host.dataset.empty = String((host.textContent ?? "").replaceAll(ZWSP, "") === "");
  }, []);

  useEffect(() => {
    const onSelectionChange = () => {
      const host = hostRef.current;
      if (!host) return;
      // Not gated on activeElement: WebKit fires selectionchange for a click
      // before focus lands, which is when the caret slips inside the pill.
      snapCaretOutOfPill(host);
      const selection = window.getSelection();
      if (selection?.rangeCount) {
        const range = selection.getRangeAt(0);
        if (range.collapsed && host.contains(range.startContainer)) savedRange.current = range.cloneRange();
      }
      if (document.activeElement === host) caretListener.current();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    const host = hostRef.current;
    if (!host || event.defaultPrevented || composing.current) return;

    if (event.key === "Backspace") {
      // The first press eats the pill's own space. It cannot simply be removed:
      // the caret would have nowhere to live beside a trailing pill, so the
      // space shrinks to zero width and the pill is marked tight.
      const spaced = untightenedSpaceAfterPill(host);
      if (spaced) {
        event.preventDefault();
        spaced.pill.dataset.tight = "1";
        spaced.node.data = spaced.node.data.replace(NBSP, ZWSP);
        caretBesidePill(spaced.pill, true);
        sync(host);
        onCaretChange();
        return;
      }
      // Blink and Gecko delete a non-editable node natively, WebKit silently
      // refuses and the pill becomes undeletable. Own it so all three agree.
      const pill = pillToDeleteBackward(host);
      if (pill) {
        event.preventDefault();
        removePill(pill);
        ensurePillBoundaries(host);
        sync(host);
        onCaretChange();
      }
      return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (event.shiftKey || event.metaKey || event.altKey) return;
      // A pill plus its boundary fillers is several DOM caret positions on one
      // visual spot, so native arrows burn presses that look dead.
      const forward = event.key === "ArrowRight";
      const pill = adjacentPill(host, forward);
      if (pill && caretBesidePill(pill, forward)) {
        event.preventDefault();
        onCaretChange();
      }
    }
  };

  const handleInput = () => {
    const host = hostRef.current;
    if (!host) return;
    // Mid-composition the IME owns the DOM: moving nodes around under it
    // cancels the candidate window, so the invariants wait for compositionend.
    if (composing.current) {
      sync(host);
      return;
    }
    // Any edit can resurrect an editable pill (WebKit paste, drag, autocorrect)
    // or strand one against the host edge, so both invariants are re-asserted
    // on every input rather than only at insert time.
    reassertPills(host);
    ensurePillBoundaries(host);
    sync(host);
    onCaretChange();
  };

  const handleCompositionStart = () => {
    composing.current = true;
    onCompositionStateChange?.(true);
  };

  const handleCompositionEnd = () => {
    composing.current = false;
    onCompositionStateChange?.(false);
    const host = hostRef.current;
    if (!host) return;
    reassertPills(host);
    ensurePillBoundaries(host);
    sync(host);
    onCaretChange();
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const consumed = onPaste?.(event) === true;
    // Rich HTML must never reach the host, so the native paste is always
    // cancelled whether the composer took the event or not.
    event.preventDefault();
    const host = hostRef.current;
    if (consumed || !host) return;
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    insertTextAtCaret(text.replace(/\r\n?/g, "\n"));
    ensurePillBoundaries(host);
    sync(host);
    onCaretChange();
  };

  useImperativeHandle(ref, () => ({
    focus() {
      hostRef.current?.focus();
    },
    clear() {
      const host = hostRef.current;
      if (!host) return;
      const focused = document.activeElement === host;
      host.replaceChildren();
      savedRange.current = null;
      if (focused) restoreCaret();
      sync(host);
    },
    isEmpty() {
      const host = hostRef.current;
      return !host || serializeHost(host).trim() === "";
    },
    getValue() {
      const host = hostRef.current;
      return host ? serializeHost(host) : "";
    },
    setValue(text: string) {
      const host = hostRef.current;
      if (!host) return;
      const focused = document.activeElement === host;
      setHostContent(host, text);
      savedRange.current = null;
      if (focused) restoreCaret();
      sync(host);
    },
    getTextBeforeCaret() {
      const host = hostRef.current;
      return (host && textBeforeCaret(host)) ?? "";
    },
    hasPillBeforeCaret() {
      const host = hostRef.current;
      return host ? pillBeforeCaret(host) !== null : false;
    },
    replaceBeforeCaret(count: number, text: string) {
      const host = restoreCaret();
      if (!host) return;
      replaceBeforeCaret(host, count, text);
      reassertPills(host);
      ensurePillBoundaries(host);
      sync(host);
      onCaretChange();
    },
    insertPill(skill: string) {
      const host = restoreCaret();
      if (!host) return;
      insertPillAtCaret(host, skill);
      sync(host);
      onCaretChange();
    },
    insertText(text: string) {
      const host = restoreCaret();
      if (!host) return;
      insertTextAtCaret(text);
      ensurePillBoundaries(host);
      sync(host);
      onCaretChange();
    },
  }));

  return (
    <div
      ref={hostRef}
      className={className ? `composer-pill-host ${className}` : "composer-pill-host"}
      contentEditable={!disabled}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      aria-disabled={disabled || undefined}
      data-placeholder={placeholder}
      data-empty="true"
      data-testid="composer-editor"
      onKeyDown={handleKeyDown}
      onInput={handleInput}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onPaste={handlePaste}
      onFocus={onFocus}
      onBlur={onBlur}
      style={{
        outline: "none",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        overflowY: "auto",
        ...style,
        maxHeight,
      }}
    />
  );
}

export default forwardRef(PillEditor);
