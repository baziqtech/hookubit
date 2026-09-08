import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button, Dialog, Field, Input, WriteErrorNotice } from '../../components';
import { formatRelativeTime, formatTimestamp } from '../../lib/format';
import type { Endpoint } from '../../types/api';
import { useDisableEndpoint, useEnableEndpoint } from './api';
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
 *     chose this; twenty consecutive failures did. Re-enabling changes nothing
 *     about the consumer that was refusing the requests, so the next run of
 *     failures re-opens the breaker and the endpoint is disabled a second time
 *     — with a burst of queued deliveries thrown at a broken consumer on the
 *     way. The control is therefore "Resume deliveries anyway": it offers the
 *     action, and the word `anyway` refuses to imply that anything has been
 *     fixed. Calling it "Fix", "Restore" or a bare "Enable" would.
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
 * The wording rules themselves are in `breaker.ts`, as pure data, because they
 * are the part worth testing and this workspace has no DOM.
 */
export function EndpointActions({
  endpoint,
  projectId,
  size = 'sm',
}: {
  endpoint: Endpoint;
  projectId: string;
  size?: 'sm' | 'md';
}) {
  const [confirming, setConfirming] = useState<'enable' | 'disable' | null>(null);

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
      </span>

      {confirming === 'enable' && (
        <EnableDialog
          endpoint={endpoint}
          projectId={projectId}
          autoDisabled={autoDisabled}
          onClose={() => setConfirming(null)}
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
    </>
  );
}

/**
 * Moves focus onto the failure the moment it appears.
 *
 * A mutation that fails inside a dialog leaves focus on a button whose label
 * has not changed, so a screen-reader user is told nothing and a sighted user
 * is looking at the wrong end of the box. `role="alert"` announces the text;
 * this puts the caret next to it as well.
 */
function useFocusOnError(isError: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isError) ref.current?.focus();
  }, [isError]);
  return ref;
}

function EnableDialog({
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
  const enable = useEnableEndpoint(projectId, endpoint.id);
  const errorRef = useFocusOnError(enable.isError);
  const controls = endpointControls(endpoint);

  return (
    <Dialog
      open
      onClose={onClose}
      title={controls.resumeTitle}
      description={endpoint.name}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={controls.resumeIsRisky ? 'danger' : 'primary'}
            loading={enable.isPending}
            onClick={() => enable.mutate(undefined, { onSuccess: onClose })}
          >
            {controls.resumeConfirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={enable.error} />
        </div>

        {autoDisabled ? (
          <>
            <p>
              <strong className="text-ink">Nothing here has been fixed.</strong> The circuit
              breaker disabled this endpoint because the consumer stopped answering, and resuming
              does not change the consumer. If it is still failing, the next run of failures opens
              the breaker again and the endpoint is disabled a second time.
            </p>
            <p>
              Queued deliveries resume immediately, so a consumer that is still broken receives a
              burst rather than a trickle. Resume once you have a reason to believe the other end
              is answering again.
            </p>
          </>
        ) : (
          <p>
            This endpoint was paused by a person, so resuming reverses that decision. Deliveries
            queued while it was paused were not discarded and will be attempted.
          </p>
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

        <p className="text-2xs text-ink-subtle">
          An endpoint with no active signing secret cannot be resumed — the data plane fails closed
          rather than delivering unsigned, so enabling would only queue failures. Rotate a secret
          first.
        </p>
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
            form="disable-endpoint-form"
            variant="danger"
            loading={disable.isPending}
          >
            Pause deliveries
          </Button>
        </>
      }
    >
      <form id="disable-endpoint-form" onSubmit={onSubmit} className="flex flex-col gap-3">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          {/*
            No `claimedFields`: nothing here maps a server rejection onto the
            reason input, so claiming the field would hide the only copy of it.
          */}
          <WriteErrorNotice error={disable.error} />
        </div>

        <p className="text-xs leading-relaxed text-ink-muted">
          Queued deliveries are <strong className="text-ink">not discarded</strong> — they wait.
          {autoDisabled
            ? ' Pausing turns the breaker’s verdict into a decision a person made, with a reason, so the delivery gap can be explained later.'
            : ' Nothing is delivered to this endpoint until it is resumed.'}
        </p>

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
