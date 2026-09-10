import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button, Dialog, Field, Input, WriteErrorNotice } from '../../components';
import { formatRelativeTime, formatTimestamp } from '../../lib/format';
import { useFocusOnError } from '../../lib/use-focus-on-error';
import type { Endpoint } from '../../types/api';
import { useDeleteEndpoint, useDisableEndpoint, useEnableEndpoint } from './api';
import { endpointControls } from './breaker';

/**
 * The cure that belongs next to the diagnosis.
 *
 * The delivery page can already say "no retry will run — the circuit breaker
 * has disabled this endpoint". That sentence is useless on its own: it tells an
 * operator what is wrong and then sends them somewhere else to do something
 * about it, which at 2am means a second search for the endpoint by name.
 *
 * ## What the button is allowed to say
 *
 * There are two ways an endpoint stops delivering and they are NOT the same
 * event, so they must not share an affordance:
 *
 *   - `enabled: true, status: 'disabled'` — the CIRCUIT BREAKER opened. Nobody
 *     chose this; a run of consecutive failures did (five opens the breaker —
 *     `OpenThreshold` in the data plane's `worker/breaker.go`, and the
 *     endpoint is switched off after the breaker has stayed open for days).
 *     Re-enabling changes nothing about the consumer that was refusing the
 *     requests, so the next run of failures re-opens the breaker and the
 *     endpoint is disabled a second time. The control is therefore "Resume
 *     deliveries anyway": it offers the action, and the word `anyway` refuses
 *     to imply that anything has been fixed. Calling it "Fix", "Restore" or a
 *     bare "Enable" would.
 *
 *   - `enabled: false` — a PERSON paused it. Reversing your own decision is an
 *     ordinary action and reads as one: "Resume deliveries".
 *
 * The honest third option, when the consumer is known to be broken, is to pause
 * the endpoint deliberately. That converts a platform verdict into a recorded
 * operator decision with a reason in the audit log — which is what makes the
 * delivery gap explainable next week — and stops the retry churn. So it is
 * offered alongside, not hidden.
 *
 * ## What pausing does to the queue — verified against the data plane
 *
 * The dialog used to say queued deliveries "are not discarded — they wait".
 * They do not wait. `router/plan.go` `gate()` SKIPS a non-active endpoint at
 * fan-out, so an event published while the endpoint is paused produces no
 * delivery row for it at all; and `worker/deliver.go` finishes any delivery
 * already queued for a paused endpoint as `cancelled` the moment a worker
 * claims it (`Endpoint.Deliverable()` in `worker/store.go`), because the retry
 * budget exists for consumers that might come back and an operator's pause is
 * not a transient fault. Nothing already in the ledger is erased, and a
 * cancelled delivery can be replayed — but nothing resumes on its own.
 *
 * The wording rules themselves are in `breaker.ts`, as pure data, because they
 * are the part worth testing and this workspace has no DOM.
 */
export function EndpointActions({
  endpoint,
  projectId,
  size = 'sm',
  onOpenSecrets,
}: {
  endpoint: Endpoint;
  projectId: string;
  size?: 'sm' | 'md';
  /**
   * Opens the Secrets dialog for this endpoint. When an endpoint has no live
   * secret, "Resume" cannot succeed (`POST …/enable` answers 409), so the
   * resume dialog hands over to this instead of offering the refusal.
   */
  onOpenSecrets?: () => void;
}) {
  const [confirming, setConfirming] = useState<'enable' | 'disable' | 'delete' | null>(null);

  const controls = endpointControls(endpoint);

  // A deleted endpoint is kept forever so the delivery ledger stays readable,
  // and every write against it is a 409. Offering a button would be offering a
  // refusal.
  if (controls.condition === 'deleted') return null;

  const autoDisabled = controls.condition === 'auto_disabled';

  return (
    <>
      <span className="flex flex-wrap items-center gap-2">
        {controls.resumeLabel && (
          <Button
            size={size}
            variant={controls.resumeIsRisky ? 'secondary' : 'primary'}
            onClick={() => setConfirming('enable')}
          >
            {controls.resumeLabel}
          </Button>
        )}
        {controls.pauseLabel && (
          <Button size={size} onClick={() => setConfirming('disable')}>
            {controls.pauseLabel}
          </Button>
        )}
        <Button size={size} variant="ghost" onClick={() => setConfirming('delete')}>
          Delete
        </Button>
      </span>

      {confirming === 'enable' && (
        <EnableDialog
          endpoint={endpoint}
          projectId={projectId}
          autoDisabled={autoDisabled}
          onClose={() => setConfirming(null)}
          onOpenSecrets={
            onOpenSecrets &&
            (() => {
              setConfirming(null);
              onOpenSecrets();
            })
          }
        />
      )}
      {confirming === 'disable' && (
        <DisableDialog
          endpoint={endpoint}
          projectId={projectId}
          autoDisabled={autoDisabled}
          onClose={() => setConfirming(null)}
        />
      )}
      {confirming === 'delete' && (
        <DeleteDialog endpoint={endpoint} projectId={projectId} onClose={() => setConfirming(null)} />
      )}
    </>
  );
}

function EnableDialog({
  endpoint,
  projectId,
  autoDisabled,
  onClose,
  onOpenSecrets,
}: {
  endpoint: Endpoint;
  projectId: string;
  autoDisabled: boolean;
  onClose: () => void;
  onOpenSecrets?: () => void;
}) {
  const enable = useEnableEndpoint(projectId, endpoint.id);
  const errorRef = useFocusOnError(enable.isError);
  const controls = endpointControls(endpoint);
  // `has_live_secret` is the same condition `POST …/enable` refuses on,
  // evaluated the same way. Offering "Resume" here is offering a 409.
  const unsigned = !endpoint.has_live_secret;

  return (
    <Dialog
      open
      onClose={onClose}
      title={unsigned ? 'This endpoint cannot be resumed yet' : controls.resumeTitle}
      description={endpoint.name}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {unsigned ? (
            onOpenSecrets && (
              <Button variant="primary" onClick={onOpenSecrets}>
                Open secrets
              </Button>
            )
          ) : (
            <Button
              variant={controls.resumeIsRisky ? 'danger' : 'primary'}
              loading={enable.isPending}
              onClick={() => enable.mutate(undefined, { onSuccess: onClose })}
            >
              {controls.resumeConfirmLabel}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={enable.error} />
        </div>

        {unsigned ? (
          <p>
            <strong className="text-ink">No signing secret is live for this endpoint</strong>, so
            the data plane would refuse to deliver to it — it fails closed rather than send
            unsigned requests, and enabling would only queue failures. An owner or admin must
            rotate a secret and hand the plaintext to whoever runs the consumer first; then
            resume.
          </p>
        ) : autoDisabled ? (
          <>
            <p>
              <strong className="text-ink">Nothing here has been fixed.</strong> The circuit
              breaker disabled this endpoint because the consumer stopped answering, and resuming
              does not change the consumer. If it is still failing, the next run of failures opens
              the breaker again and the endpoint is disabled a second time.
            </p>
            <p>
              Resuming brings the breaker’s next probe forward to now and admits exactly one
              delivery until the consumer answers; the rest of the backlog follows only once it
              has. Deliveries already finished as <span className="font-mono">cancelled</span>{' '}
              while it was switched off do not restart — replay the ones that must still arrive.
            </p>
          </>
        ) : (
          <>
            <p>
              This endpoint was paused by a person, so resuming reverses that decision. From now on
              new events produce deliveries for it again.
            </p>
            <p>
              <strong className="text-ink">Nothing from the pause is sent by resuming.</strong>{' '}
              Events published while it was paused produced no deliveries for this endpoint, and
              deliveries that were queued when it was paused were finished as{' '}
              <span className="font-mono">cancelled</span>. Replay the events or deliveries that
              must still arrive.
            </p>
          </>
        )}

        {endpoint.disabled_reason && (
          <p className="rounded border border-line bg-raised/60 px-2.5 py-1.5 text-2xs text-ink-muted">
            {endpoint.disabled_reason}
            {endpoint.disabled_at && (
              <span className="text-ink-subtle">
                {' '}
                · {formatRelativeTime(endpoint.disabled_at)} (
                {formatTimestamp(endpoint.disabled_at)})
              </span>
            )}
          </p>
        )}
      </div>
    </Dialog>
  );
}

interface DisableForm {
  reason: string;
}

/** `DisableEndpointDto.reason` — `@MaxLength(200)`, and audited. */
const MAX_REASON_LENGTH = 200;

function DisableDialog({
  endpoint,
  projectId,
  autoDisabled,
  onClose,
}: {
  endpoint: Endpoint;
  projectId: string;
  autoDisabled: boolean;
  onClose: () => void;
}) {
  // A per-instance id, not a literal. A dialog can be mounted more than once
  // on a page (the switcher and the empty state both own a create dialog), and
  // a footer button's `form` attribute binds to the FIRST element with that
  // id in the document - which was the other, closed dialog's form, whose
  // validation failed on empty fields and never sent a request.
  const formId = useId();
  const disable = useDisableEndpoint(projectId, endpoint.id);
  const errorRef = useFocusOnError(disable.isError);
  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors },
  } = useForm<DisableForm>({ defaultValues: { reason: '' } });

  const onSubmit = handleSubmit(
    (values) => {
      const reason = values.reason.trim();
      disable.mutate(reason ? { reason } : {}, { onSuccess: onClose });
    },
    // A rejected submit must move the caret to the field that caused it.
    () => setFocus('reason'),
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title="Pause deliveries?"
      description={endpoint.name}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form={formId}
            variant="danger"
            loading={disable.isPending}
          >
            Pause deliveries
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-3">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          {/*
            No `claimedFields`: nothing here maps a server rejection onto the
            reason input, so claiming the field would hide the only copy of it.
          */}
          <WriteErrorNotice error={disable.error} />
        </div>

        <div className="flex flex-col gap-1.5 text-xs leading-relaxed text-ink-muted">
          <p>
            <strong className="text-ink">Queued deliveries are cancelled, not held.</strong> Each
            delivery already queued or retrying for this endpoint is finished as{' '}
            <span className="font-mono">cancelled</span> as a worker reaches it, and new events stop
            producing deliveries for it. Nothing already recorded in the ledger is erased, and a
            cancelled delivery can be replayed once the endpoint is resumed — but nothing is sent
            on its own.
          </p>
          <p>
            {autoDisabled
              ? 'Pausing turns the breaker’s verdict into a decision a person made, with a reason, so the delivery gap can be explained later.'
              : 'Nothing is delivered to this endpoint until it is resumed.'}
          </p>
        </div>

        <Field
          label="Reason"
          hint={`Written to the audit log. Optional, up to ${MAX_REASON_LENGTH} characters.`}
          error={errors.reason?.message}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              placeholder="Consumer returning 500s — partner incident PB-4471"
              {...register('reason', {
                maxLength: {
                  value: MAX_REASON_LENGTH,
                  message: `Keep this to ${MAX_REASON_LENGTH} characters or fewer.`,
                },
              })}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

/**
 * Soft delete, stated as what it is.
 *
 * `DELETE …/endpoints/:id` never removes the row: `deliveries.endpoint_id` is
 * ON DELETE RESTRICT so "did finance ever receive this?" stays answerable after
 * the endpoint is gone. What the operator loses is the ability to change it —
 * every later write answers 409 — and there is no undelete. That is the fact
 * the confirmation has to carry, not "are you sure".
 */
function DeleteDialog({
  endpoint,
  projectId,
  onClose,
}: {
  endpoint: Endpoint;
  projectId: string;
  onClose: () => void;
}) {
  const remove = useDeleteEndpoint(projectId, endpoint.id);
  const errorRef = useFocusOnError(remove.isError);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Delete this endpoint?"
      description={endpoint.name}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => remove.mutate(undefined, { onSuccess: onClose })}
          >
            Delete endpoint
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={remove.error} />
        </div>
        <p>
          <strong className="text-ink">This cannot be undone.</strong> The endpoint stops receiving
          deliveries, its status becomes <span className="font-mono">deleted</span>, and every later
          change to it is refused — there is no undelete, and its signing secrets go with it.
        </p>
        <p>
          The row itself is kept forever so the delivery ledger stays readable: every delivery
          and attempt that ever pointed at{' '}
          <span className="font-mono text-ink">{endpoint.url}</span> keeps pointing at it. Tick
          “Show deleted endpoints” to see it afterwards.
        </p>
        <p className="text-2xs text-ink-subtle">
          Subscriptions bound to this endpoint stop matching; delete or re-point them separately.
        </p>
      </div>
    </Dialog>
  );
}
