import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  Async,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Pager,
  PermissionDenied,
  SecretReveal,
  Table,
  WriteErrorNotice,
  type Column,
} from '../../components';
import { ApiRequestError } from '../../lib/api';
import { classifyWriteError } from '../../lib/api-errors';
import { formatRelativeTime, formatTimestamp } from '../../lib/format';
import { useFocusOnError } from '../../lib/use-focus-on-error';
import {
  DEFAULT_OVERLAP_SECONDS,
  DEFAULT_PAGE_SIZE,
  type Endpoint,
  type EndpointSecret,
  type Role,
  type RotatedSecret,
} from '../../types/api';
import { useEndpointSecrets, useRevokeSecret, useRotateSecret } from './api';
import {
  MAX_OVERLAP_SECONDS,
  MIN_OVERLAP_SECONDS,
  SECRET_CONDITION_LABEL,
  SECRET_ROLES,
  describeOverlap,
  isDefaultOverlap,
  mayManageSecrets,
  rejectOverlapSeconds,
  secretCondition,
  wouldBeLastActive,
} from './secrets';

/**
 * Signing secrets for one endpoint: the list of versions, rotation, and
 * retiring a single version.
 *
 * ## Why this dialog exists
 *
 * It is the cure for two states the rest of the product can only diagnose:
 *
 *   - `secret_pending` — an endpoint created by a developer comes back PAUSED
 *     with no secret anyone holds. `EndpointCreatedNotice` says an owner or
 *     admin must rotate; this is where they do it.
 *   - `has_live_secret: false` — `POST …/enable` answers 409 until a secret
 *     signs. "Resume" on such a row hands over to this dialog rather than
 *     offering a guaranteed refusal.
 *
 * ## What it must never do
 *
 * Show a plaintext from anywhere but the rotate response. `EndpointSecretDto`
 * has no field a plaintext could occupy, and the rotate response is held in
 * this component's state for as long as the reveal is on screen and nowhere
 * else — not the query cache, not the URL.
 *
 * ## Who may open it
 *
 * `endpoint-secrets.*` is owner and admin ONLY and is not implied by
 * `endpoints.read`. A developer or viewer who can see the endpoint is refused
 * with a 403, and that is rendered as `PermissionDenied` naming their role —
 * pre-empted from `OrganizationDto.role` when it is known, and honoured from
 * the server's answer when it is not.
 */
export function EndpointSecretsDialog({
  endpoint,
  currentRole,
  onClose,
}: {
  endpoint: Pick<Endpoint, 'id' | 'name' | 'status' | 'has_live_secret'>;
  currentRole?: Role;
  onClose: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<
    { kind: 'list' } | { kind: 'rotate' } | { kind: 'revoke'; secret: EndpointSecret }
  >({ kind: 'list' });
  // The one-time plaintext. Component state only; dropped on close.
  const [rotated, setRotated] = useState<RotatedSecret | null>(null);

  const allowed = mayManageSecrets(currentRole);
  const secrets = useEndpointSecrets(endpoint.id, offset, allowed);
  const deleted = endpoint.status === 'deleted';

  const close = () => {
    setRotated(null);
    onClose();
  };

  if (!allowed || isForbidden(secrets.error)) {
    return (
      <Dialog
        open
        onClose={close}
        title="Signing secrets"
        description={endpoint.name}
        footer={<Button onClick={close}>Close</Button>}
      >
        <PermissionDenied
          action="read or rotate this endpoint’s signing secrets"
          requiredRoles={[...SECRET_ROLES]}
          currentRole={currentRole}
          error={secrets.error}
        />
      </Dialog>
    );
  }

  if (rotated) {
    return (
      <Dialog
        open
        onClose={close}
        title={`Secret version ${rotated.version} issued`}
        description={endpoint.name}
        footer={
          <Button variant="primary" onClick={() => setRotated(null)}>
            I have copied it
          </Button>
        }
      >
        <RotatedNotice rotated={rotated} endpoint={endpoint} />
      </Dialog>
    );
  }

  if (view.kind === 'rotate') {
    return (
      <RotateDialog
        endpoint={endpoint}
        onClose={close}
        onBack={() => setView({ kind: 'list' })}
        onRotated={(result) => {
          setRotated(result);
          setView({ kind: 'list' });
        }}
      />
    );
  }

  if (view.kind === 'revoke') {
    return (
      <RevokeDialog
        endpoint={endpoint}
        secret={view.secret}
        page={secrets.data ?? { rows: [], hasMore: false, nextOffset: null }}
        onClose={close}
        onBack={() => setView({ kind: 'list' })}
        onRotateInstead={() => setView({ kind: 'rotate' })}
      />
    );
  }

  return (
    <Dialog
      open
      onClose={close}
      size="lg"
      title="Signing secrets"
      description={endpoint.name}
      footer={
        <>
          <Button onClick={close}>Close</Button>
          {!deleted && (
            <Button variant="primary" onClick={() => setView({ kind: 'rotate' })}>
              Rotate secret
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {!endpoint.has_live_secret && !deleted && (
          <p
            role="status"
            className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-ink-muted"
          >
            <strong className="text-warn">Nothing is signing for this endpoint.</strong> It cannot
            be resumed until a secret does — the data plane fails closed rather than deliver
            unsigned. Rotate to issue one, hand the plaintext to whoever runs the consumer, then
            resume the endpoint.
          </p>
        )}
        {deleted && (
          <p className="text-xs text-ink-muted">
            This endpoint is deleted. Its versions are listed for the ledger; nothing can be
            rotated for it.
          </p>
        )}

        <p className="text-xs text-ink-muted">
          Metadata only. A plaintext is shown exactly once, in the response that mints it, and
          cannot be recovered afterwards by anyone — rotate if it is lost.
        </p>

        <Async
          query={secrets}
          isEmpty={(page) => page.rows.length === 0}
          empty={
            <EmptyState
              title="No secrets"
              description="This endpoint has never had a signing secret. Rotate to issue version 1."
            />
          }
        >
          {(page) => (
            <>
              <Table
                caption="Signing secret versions"
                columns={buildColumns(deleted ? null : (secret) => setView({ kind: 'revoke', secret }))}
                rows={page.rows}
                rowKey={(row) => row.id}
              />
              <Pager
                page={page}
                offset={offset}
                onOffsetChange={setOffset}
                limit={DEFAULT_PAGE_SIZE}
                label="secret versions"
              />
            </>
          )}
        </Async>
      </div>
    </Dialog>
  );
}

function isForbidden(error: unknown): error is ApiRequestError {
  return (
    error instanceof ApiRequestError &&
    (error.status === 403 || error.body.code === 'forbidden')
  );
}

function buildColumns(onRevoke: ((secret: EndpointSecret) => void) | null): Column<EndpointSecret>[] {
  const columns: Column<EndpointSecret>[] = [
    {
      key: 'version',
      header: 'Version',
      render: (row) => <span className="font-mono text-xs text-ink">v{row.version}</span>,
    },
    {
      key: 'state',
      header: 'State',
      render: (row) => {
        const condition = secretCondition(row);
        return (
          <span className="flex flex-col gap-0.5">
            <Badge tone={condition === 'retired' ? 'neutral' : condition === 'expiring' ? 'warn' : 'ok'} dot>
              {SECRET_CONDITION_LABEL[condition]}
              {condition === 'expiring' && row.expires_at && ` ${formatRelativeTime(row.expires_at)}`}
            </Badge>
            {row.expires_at && (
              <span className="text-2xs text-ink-subtle">
                {condition === 'retired' ? 'stopped' : 'stops'} {formatTimestamp(row.expires_at)}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'rotated',
      header: 'Superseded',
      secondary: true,
      render: (row) => (
        <span className="text-2xs text-ink-subtle">
          {row.rotated_at ? formatRelativeTime(row.rotated_at) : '—'}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      align: 'right',
      render: (row) => (
        <span className="text-2xs text-ink-subtle">{formatRelativeTime(row.created_at)}</span>
      ),
    },
  ];

  if (onRevoke) {
    columns.push({
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) =>
        row.active ? (
          <Button size="sm" onClick={() => onRevoke(row)}>
            Revoke
          </Button>
        ) : null,
    });
  }
  return columns;
}

/* ── Rotate ───────────────────────────────────────────────────────────────── */

interface RotateForm {
  overlap_seconds: number;
}

/**
 * The overlap window is the whole decision, so it is the only input.
 *
 * `overlap_seconds` is validated here in the server's words so a typo is
 * caught before a round trip, and a server rejection naming the field is
 * placed under the input rather than in a paragraph.
 */
function RotateDialog({
  endpoint,
  onClose,
  onBack,
  onRotated,
}: {
  endpoint: Pick<Endpoint, 'id' | 'name' | 'has_live_secret'>;
  onClose: () => void;
  onBack: () => void;
  onRotated: (result: RotatedSecret) => void;
}) {
  // A per-instance id, not a literal. A dialog can be mounted more than once
  // on a page (the switcher and the empty state both own a create dialog), and
  // a footer button's `form` attribute binds to the FIRST element with that
  // id in the document - which was the other, closed dialog's form, whose
  // validation failed on empty fields and never sent a request.
  const formId = useId();
  const rotate = useRotateSecret(endpoint.id);
  const {
    register,
    handleSubmit,
    watch,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<RotateForm>({ defaultValues: { overlap_seconds: DEFAULT_OVERLAP_SECONDS } });
  const claimed = errors.overlap_seconds ? ['overlap_seconds'] : [];
  const errorRef = useFocusOnError(rotate.isError && claimed.length === 0);

  const raw = watch('overlap_seconds');
  const overlap = Number(raw);
  const preview = Number.isFinite(overlap) && overlap >= 0 ? describeOverlap(overlap) : null;
  const first = !endpoint.has_live_secret;

  const onSubmit = handleSubmit(
    (values) => {
      const seconds = Number(values.overlap_seconds);
      // Omit the field when it is the default so the server's own default
      // applies, rather than pinning a number this form happened to know.
      rotate.mutate(isDefaultOverlap(seconds) ? {} : { overlap_seconds: seconds }, {
        onSuccess: onRotated,
        onError: (error) => {
          const failure = classifyWriteError(error);
          if (failure.kind !== 'invalid') return;
          const issue = failure.issues.find((candidate) => candidate.field === 'overlap_seconds');
          if (!issue) return;
          setError('overlap_seconds', { type: 'server', message: issue.reason });
          setFocus('overlap_seconds');
        },
      });
    },
    () => setFocus('overlap_seconds'),
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={first ? 'Issue a signing secret?' : 'Rotate the signing secret?'}
      description={endpoint.name}
      footer={
        <>
          <Button onClick={onBack}>Back</Button>
          <Button
            type="submit"
            form={formId}
            variant={overlap === 0 && !first ? 'danger' : 'primary'}
            loading={rotate.isPending}
          >
            {first ? 'Issue secret' : overlap === 0 ? 'Rotate and retire the old secrets now' : 'Rotate'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-3">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={rotate.error} claimedFields={claimed} />
        </div>

        <p className="text-xs leading-relaxed text-ink-muted">
          A new secret is minted and starts signing immediately. Its plaintext is shown{' '}
          <strong className="text-ink">once</strong>, on the next screen, and must be handed to
          whoever runs the consumer.
        </p>

        {first ? (
          <p className="text-xs leading-relaxed text-ink-muted">
            Nothing is signing yet, so there is no window to overlap: this issues the first live
            secret. Once the consumer holds it, resume the endpoint.
          </p>
        ) : (
          <Field
            label="Overlap (seconds)"
            hint={`How long the current secrets keep signing alongside the new one. ${DEFAULT_OVERLAP_SECONDS} is the default (24 hours); ${MAX_OVERLAP_SECONDS} is the maximum (30 days). 0 retires them immediately.`}
            error={errors.overlap_seconds?.message}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                min={MIN_OVERLAP_SECONDS}
                max={MAX_OVERLAP_SECONDS}
                step={1}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                className="w-40"
                {...register('overlap_seconds', {
                  valueAsNumber: true,
                  validate: (value) => rejectOverlapSeconds(value) ?? true,
                })}
              />
            )}
          </Field>
        )}

        {!first && preview && (
          <p
            className={
              overlap === 0
                ? 'rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink-muted'
                : 'rounded-md border border-line bg-raised/60 px-3 py-2 text-xs text-ink-muted'
            }
          >
            <strong className={overlap === 0 ? 'text-danger' : 'text-ink'}>{preview.headline}</strong>{' '}
            {preview.detail}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/**
 * The one-time reveal, with the two facts the consumer's operator needs
 * alongside the value: which prior versions still sign, and until when.
 */
function RotatedNotice({
  rotated,
  endpoint,
}: {
  rotated: RotatedSecret;
  endpoint: Pick<Endpoint, 'has_live_secret'>;
}) {
  return (
    <div className="flex flex-col gap-3">
      <SecretReveal value={rotated.secret} label={`signing secret v${rotated.version}`} />
      <p className="text-xs leading-relaxed text-ink-muted">
        {rotated.overlapping_versions.length === 0 ? (
          <>
            <strong className="text-ink">Only version {rotated.version} signs from now on.</strong>{' '}
            {rotated.previous_secrets_expire_at === null && endpoint.has_live_secret
              ? 'The previous secrets have been retired; a consumer still verifying with one of them will reject every delivery until it is switched.'
              : 'Hand it to the consumer, then resume the endpoint.'}
          </>
        ) : (
          <>
            Version{rotated.overlapping_versions.length > 1 ? 's' : ''}{' '}
            <span className="font-mono">{rotated.overlapping_versions.map((v) => `v${v}`).join(', ')}</span>{' '}
            {rotated.overlapping_versions.length > 1 ? 'keep' : 'keeps'} signing until{' '}
            <strong className="text-ink">{formatTimestamp(rotated.previous_secrets_expire_at)}</strong>
            {rotated.previous_secrets_expire_at && (
              <span className="text-ink-subtle"> ({formatRelativeTime(rotated.previous_secrets_expire_at)})</span>
            )}
            . Every delivery carries one signature per active secret until then, so switch the
            consumer to v{rotated.version} before that moment and nothing is dropped.
          </>
        )}
      </p>
    </div>
  );
}

/* ── Revoke ───────────────────────────────────────────────────────────────── */

/**
 * Retire ONE version. The server refuses it when that version is the last one
 * signing for a live endpoint — the remedy it names is a rotation with zero
 * overlap, so that remedy is a button here rather than a sentence.
 */
function RevokeDialog({
  endpoint,
  secret,
  page,
  onClose,
  onBack,
  onRotateInstead,
}: {
  endpoint: Pick<Endpoint, 'id' | 'name' | 'status'>;
  secret: EndpointSecret;
  page: { rows: EndpointSecret[]; hasMore: boolean };
  onClose: () => void;
  onBack: () => void;
  onRotateInstead: () => void;
}) {
  const revoke = useRevokeSecret(endpoint.id);
  const errorRef = useFocusOnError(revoke.isError);
  const last = wouldBeLastActive(secret, page, endpoint.status);
  const refused = revoke.isError && classifyWriteError(revoke.error).kind === 'conflict';

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Revoke secret v${secret.version}?`}
      description={endpoint.name}
      footer={
        <>
          <Button onClick={onBack}>Back</Button>
          {last === true || refused ? (
            <Button variant="danger" onClick={onRotateInstead}>
              Rotate with zero overlap instead
            </Button>
          ) : (
            <Button
              variant="danger"
              loading={revoke.isPending}
              onClick={() => revoke.mutate(secret.id, { onSuccess: onBack })}
            >
              Revoke v{secret.version}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          {/* The 409 is the server's own sentence, shown whole — it names the remedy. */}
          <WriteErrorNotice error={revoke.error} />
        </div>

        {last === true ? (
          <p>
            <strong className="text-ink">This is the only secret currently signing.</strong>{' '}
            Revoking it would make every delivery fail unsigned, so the server refuses. To stop
            it signing now, rotate with an overlap of 0: a new secret takes over at the same
            moment this one stops.
          </p>
        ) : (
          <>
            <p>
              Version {secret.version} stops signing <strong className="text-ink">immediately</strong>
              . A consumer still verifying with it will reject every delivery until it is switched
              to a version that still signs.
            </p>
            {last === null && (
              <p className="text-2xs text-ink-subtle">
                The list is longer than one page, so whether another secret still signs is not
                known here. If this is the last one, the server refuses and says so.
              </p>
            )}
            <p className="text-2xs text-ink-subtle">
              A rotation with an overlap already retires the old version on a deadline; revoke
              only when it must stop before that.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
