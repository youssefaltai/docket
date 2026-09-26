// The one dialog primitive: a focus-trapped, Esc/⌘Enter-aware portal used by every modal and popup form.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cls } from "./util";

export function Modal({
  label,
  className,
  onClose,
  onSubmit,
  children,
}: {
  label: string;
  className?: string;
  onClose: () => void;
  onSubmit?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // What had focus when it opened (read on first render: autofocus moves it before effects run).
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(
    () => () => {
      // After the close lands (StrictMode's rehearsal unmount remounts at once, so skip it then),
      // give focus back unless something else has taken it.
      setTimeout(() => {
        if (!ref.current && (document.activeElement === document.body || !document.activeElement)) opener?.focus?.({ preventScroll: true });
      });
    },
    [],
  );
  return createPortal(
    <div
      className="backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={cls("modal", className)}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={(e) => {
          if (e.defaultPrevented) return;
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit?.();
          } else if (e.key === "Tab") {
            // Trap focus: cycle from the last focusable back to the first, and vice versa.
            const focusable = [
              ...ref.current!.querySelectorAll<HTMLElement>(
                'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
              ),
            ].filter((el) => el.offsetParent !== null);
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!first || !last) return;
            if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
              e.preventDefault();
              (e.shiftKey ? last : first).focus();
            }
          }
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
