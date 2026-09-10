import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, Field, GatedButton, Input, Panel, WriteErrorNotice } from '../../components';
import type { RoleGate } from '../../lib/role-gate';

/**
 * The bottom-of-the-page panel for the one write that cannot be undone.
 *
 * Kept visually apart from the forms above it — a red border, its own
 * heading — because "Delete" next to "Save changes" is how a deletion happens
 * by muscle memory. The button is gated like every other write: disabled with
 * the reason for a role that lacks the grant, never missing.
 */
export function DangerZonePanel({
  title,
  description,
  gate,
  action,
  buttonLabel,
  onClick,
  children,
}: {
  title: string;
  description: ReactNode;
  gate: RoleGate;
  /** Gerund phrase for the denial tooltip: "Deleting this project". */
  action: string;
  buttonLabel: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <Panel
      title="Danger zone"
      description="Irreversible. Each action here says exactly what it does before it does it."
      className="border-danger/40"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1 text-xs leading-relaxed text-ink-muted">
          <p className="font-medium text-ink">{title}</p>
          <div>{description}</div>
          {children}
        </div>
        <GatedButton
          variant="danger"
          gate={gate}
          action={action}
          onClick={onClick}
          className="shrink-0"
        >
          {buttonLabel}
        </GatedButton>
      </div>
    </Panel>
  );
}

/**
 * Confirm by typing the slug.
 *
 * A checkbox or a second click is not a confirmation; it is a second reflex.
 * Typing the slug of the thing being deleted makes the person read what they
 * are deleting, and it is what stops a project called "Payments" going while
 * "Payments Staging" was meant. The button stays disabled until the text
 * matches exactly.
 */
export function TypeToConfirmDialog({
  title,
  subject,
  slug,
  confirmLabel,
  mutation,
  onSuccess,
  onClose,
  children,
}: {
  title: string;
  /** Rendered as the dialog description — the name of the thing. */
  subject: string;
  slug: string;
  confirmLabel: string;
  mutation: {
    mutate: (variables: undefined, options?: { onSuccess?: () => void }) => void;
    isPending: boolean;
    isError: boolean;
    error: unknown;
  };
  onSuccess: () => void;
  onClose: () => void;
  /** What the deletion does, stated plainly, above the confirmation input. */
  children: ReactNode;
}) {
  // A per-instance id, not a literal. A dialog can be mounted more than once
  // on a page (the switcher and the empty state both own a create dialog), and
  // a footer button's `form` attribute binds to the FIRST element with that
  // id in the document - which was the other, closed dialog's form, whose
  // validation failed on empty fields and never sent a request.
  const formId = useId();
  const [typed, setTyped] = useState('');
  const matches = typed === slug;
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mutation.isError) errorRef.current?.focus();
  }, [mutation.isError]);

  const confirm = () => {
    if (!matches) return;
    mutation.mutate(undefined, { onSuccess });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={subject}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form={formId}
            variant="danger"
            disabled={!matches}
            loading={mutation.isPending}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
        className="flex flex-col gap-3"
      >
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={mutation.error} />
        </div>

        <div className="flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">{children}</div>

        <Field
          label="Confirm by typing the slug"
          required
          hint={
            <>
              Type <code className="font-mono text-ink">{slug}</code> exactly as shown. Nothing
              happens until it matches.
            </>
          }
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              mono
              autoComplete="off"
              spellCheck={false}
              aria-describedby={describedBy}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={slug}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
