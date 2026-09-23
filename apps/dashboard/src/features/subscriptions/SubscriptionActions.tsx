import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Badge, Button, Dialog, Field, GatedButton, Input, WriteErrorNotice } from '../../components';
import type { RoleGate } from '../../lib/role-gate';
import { MAX_SUBSCRIPTION_DISABLE_REASON_LENGTH, type Subscription } from '../../types/api';
import { useDeleteSubscription, useDisableSubscription, useEnableSubscription } from './api';

/**
 * Enable, disable and delete — the three writes that are NOT a PATCH.
 *
 * Each is its own route on the control API because each is a distinct,
 * separately audited act: `subscription.enabled`, `subscription.disabled`
 * (with the operator's reason) and `subscription.deleted` (with the whole
 * rule, because the row is really gone). Folding them into the edit form
 * would audit a pause as a rename.
 *
 * Every control is behind the `subscriptions.write` gate — disabled with a
 * reason for a viewer, never missing.
 */
export function SubscriptionActions({
  subscription,
  projectId,
  endpointName,
  gate,
  onEdit,
}: {
  subscription: Subscription;
  projectId: string;
  endpointName: string;
  gate: RoleGate;
  onEdit: () => void;
}) {
  const [confirming, setConfirming] = useState<'enable' | 'disable' | 'delete' | null>(null);

  return (
    <>
      <span className="flex flex-wrap items-center justify-end gap-2">
        {subscription.enabled ? (
          <GatedButton
            size="sm"
            gate={gate}
            action="Disabling a subscription"
            onClick={() => setConfirming('disable')}
          >
            Disable
          </GatedButton>
        ) : (
          <GatedButton
            size="sm"
            variant="primary"
            gate={gate}
            action="Enabling a subscription"
            onClick={() => setConfirming('enable')}
          >
            Enable
          </GatedButton>
        )}
        <GatedButton size="sm" gate={gate} action="Editing a subscription" onClick={onEdit}>
          Edit
        </GatedButton>
        <GatedButton
          size="sm"
          variant="ghost"
          gate={gate}
          action="Deleting a subscription"
          onClick={() => setConfirming('delete')}
          className="text-danger hover:text-danger"
        >
          Delete
        </GatedButton>
      </span>

      {confirming === 'enable' && (
        <EnableDialog
          subscription={subscription}
          projectId={projectId}
          endpointName={endpointName}
          onClose={() => setConfirming(null)}
        />
      )}
      {confirming === 'disable' && (
        <DisableDialog
          subscription={subscription}
          projectId={projectId}
          endpointName={endpointName}
          onClose={() => setConfirming(null)}
        />
      )}
      {confirming === 'delete' && (
        <DeleteDialog
          subscription={subscription}
          projectId={projectId}
          endpointName={endpointName}
          onClose={() => setConfirming(null)}
        />
      )}
    </>
  );
}

/** Moves focus onto the failure the moment it appears (see `EndpointActions`). */
function useFocusOnError(isError: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isError) ref.current?.focus();
  }, [isError]);
  return ref;
}

function Rule({ subscription, endpointName }: { subscription: Subscription; endpointName: string }) {
  return (
    <p className="rounded border border-line bg-raised/60 px-2.5 py-1.5 text-2xs text-ink-muted">
      <span className="text-ink">{endpointName}</span> ←{' '}
      <span className="inline-flex flex-wrap gap-1 align-middle">
        {subscription.event_types.map((type) => (
          <Badge key={type} tone={type === '*' ? 'warn' : 'neutral'} className="font-mono">
            {type}
          </Badge>
        ))}
      </span>
      {subscription.payload_filter && (
        <span className="text-ink-subtle"> · with a payload filter (not yet evaluated)</span>
      )}
    </p>
  );
}

function EnableDialog({
  subscription,
  projectId,
  endpointName,
  onClose,
}: {
  subscription: Subscription;
  projectId: string;
  endpointName: string;
  onClose: () => void;
}) {
  const enable = useEnableSubscription(projectId, subscription.id);
  const errorRef = useFocusOnError(enable.isError);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Enable this subscription?"
      description={subscription.name ?? 'Unnamed subscription'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={enable.isPending}
            onClick={() => enable.mutate(undefined, { onSuccess: onClose })}
          >
            Enable
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={enable.error} />
        </div>
        <p>
          Matching resumes for events accepted from now on. The filter is untouched. Events that
          were accepted while it was disabled were not routed here and will not be routed
          retroactively — routing is pinned to the subscriptions that existed when each event
          arrived.
        </p>
        <Rule subscription={subscription} endpointName={endpointName} />
      </div>
    </Dialog>
  );
}

interface DisableForm {
  reason: string;
}

function DisableDialog({
  subscription,
  projectId,
  endpointName,
  onClose,
}: {
  subscription: Subscription;
  projectId: string;
  endpointName: string;
  onClose: () => void;
}) {
  // A per-instance id, not a literal. A dialog can be mounted more than once
  // on a page (the switcher and the empty state both own a create dialog), and
  // a footer button's `form` attribute binds to the FIRST element with that
  // id in the document - which was the other, closed dialog's form, whose
  // validation failed on empty fields and never sent a request.
  const formId = useId();
  const disable = useDisableSubscription(projectId, subscription.id);
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
    () => setFocus('reason'),
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title="Disable this subscription?"
      description={subscription.name ?? 'Unnamed subscription'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form={formId}
            variant="danger"
            loading={disable.isPending}
          >
            Disable
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-3">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={disable.error} />
        </div>

        <p className="text-xs leading-relaxed text-ink-muted">
          A disabled subscription is skipped before the event-type test, so it matches{' '}
          <strong className="text-ink">nothing at all</strong> until it is enabled again. The
          filter is kept. Deliveries already queued are{' '}
          <strong className="text-ink">not discarded</strong> — they still run.
        </p>
        <Rule subscription={subscription} endpointName={endpointName} />

        <Field
          label="Reason"
          hint={`Written to the audit log, which is what explains the delivery gap later. Optional, up to ${MAX_SUBSCRIPTION_DISABLE_REASON_LENGTH} characters.`}
          error={errors.reason?.message}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              placeholder="Finance asked to stop settlement events during the ledger migration"
              {...register('reason', {
                maxLength: {
                  value: MAX_SUBSCRIPTION_DISABLE_REASON_LENGTH,
                  message: `Keep this to ${MAX_SUBSCRIPTION_DISABLE_REASON_LENGTH} characters or fewer.`,
                },
              })}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function DeleteDialog({
  subscription,
  projectId,
  endpointName,
  onClose,
}: {
  subscription: Subscription;
  projectId: string;
  endpointName: string;
  onClose: () => void;
}) {
  const remove = useDeleteSubscription(projectId, subscription.id);
  const errorRef = useFocusOnError(remove.isError);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Delete this subscription?"
      description={subscription.name ?? 'Unnamed subscription'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => remove.mutate(undefined, { onSuccess: onClose })}
          >
            Delete subscription
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={remove.error} />
        </div>
        <p>
          <strong className="text-ink">This is a hard delete</strong> — unlike an endpoint or a
          project, the row is really removed and there is no undelete. If you only want to stop
          deliveries down this route for a while, disable it instead and keep the filter.
        </p>
        <p>
          The delivery ledger is unaffected: every delivery keeps its own endpoint and event, so
          “did {endpointName} ever receive this?” still has an answer. Only “which routing rule
          matched” is lost from the row, and the whole rule below is written to the audit log on
          the way out.
        </p>
        <Rule subscription={subscription} endpointName={endpointName} />
      </div>
    </Dialog>
  );
}
