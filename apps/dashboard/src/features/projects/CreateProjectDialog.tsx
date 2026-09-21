import { useEffect, useId, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, Field, Input, Select, WriteErrorNotice } from '../../components';
import { classifyWriteError } from '../../lib/api-errors';
import {
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_NAME_MIN_LENGTH,
  PROJECT_SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
  type CreateProjectBody,
  type Environment,
} from '../../types/api';
import { useCreateProject, useProjects } from './api';

/**
 * `POST /v1/organizations/:orgId/projects` — everything `CreateProjectDto`
 * accepts: a name, an optional slug, and the ONE decision that cannot be
 * revisited.
 *
 * ## `environment` is immutable, and the form says so before the click
 *
 * `test` or `live`, defaulting to `test` so nothing is made live by omission.
 * It selects which API keys (`wk_test_`/`wk_live_`) and which ingest traffic
 * belong to the project, so `UpdateProjectDto` refuses it outright and the
 * only way to a different environment is a second project. A form that let
 * someone pick `live` without saying that would be the same trap as a
 * dropdown that lets them change it later.
 *
 * ## The slug is validated, never rewritten
 *
 * A supplied slug is checked against the pattern and sent as typed; an
 * omitted one is derived from the name server-side and comes back in the
 * response. A taken slug is a 409 `conflict` about ONE field, so it lands
 * under the slug input; the per-organization ceiling is a 409
 * `limit_exceeded` with `{ limit, current, resource }` and lands in the panel,
 * because nothing on this form fixes it.
 *
 * On success the operator is taken to the new project's overview — the
 * first-run checklist is there, and it is the reason a project gets made.
 */
type FormValues = {
  name: string;
  slug: string;
  environment: Environment;
  /** Empty string means "start from empty". */
  copy_from_project_id: string;
};

const SERVER_FIELDS: readonly (keyof FormValues)[] = ['name', 'slug', 'environment'];

const ENVIRONMENTS: { value: Environment; label: string }[] = [
  { value: 'test', label: 'test — throwaway keys and endpoints; the default' },
  { value: 'live', label: 'live — production traffic and wk_live_ keys' },
];

export function CreateProjectDialog({
  orgId,
  open,
  onClose,
}: {
  orgId: string;
  open: boolean;
  onClose: () => void;
}) {
  // A per-instance id, not a literal. A dialog can be mounted more than once
  // on a page (the switcher and the empty state both own a create dialog), and
  // a footer button's `form` attribute binds to the FIRST element with that
  // id in the document - which was the other, closed dialog's form, whose
  // validation failed on empty fields and never sent a request.
  const formId = useId();
  const navigate = useNavigate();
  const create = useCreateProject(orgId);
  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    reset,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: { name: '', slug: '', environment: 'test', copy_from_project_id: '' },
  });
  // Only projects that exist and are not deleted can be copied from. Already
  // in cache: the switcher that opened this dialog loaded them.
  const projects = useProjects(orgId);
  const sources = (projects.data?.rows ?? []).filter((row) => row.status === 'active');
  const copyFrom = watch('copy_from_project_id');
  const source = sources.find((row) => row.id === copyFrom);
  const errorRef = useRef<HTMLDivElement>(null);
  const claimed = SERVER_FIELDS.filter((field) => errors[field]);
  const environment = watch('environment');

  useEffect(() => {
    if (create.isError && claimed.length === 0) errorRef.current?.focus();
  }, [create.isError, claimed.length]);

  const close = () => {
    reset();
    create.reset();
    onClose();
  };

  const onSubmit = handleSubmit(
    (values) => {
      const body: CreateProjectBody = { name: values.name.trim(), environment: values.environment };
      const slug = values.slug.trim();
      if (slug) body.slug = slug;
      if (values.copy_from_project_id) body.copy_from_project_id = values.copy_from_project_id;

      create.mutate(body, {
        onSuccess: (project) => {
          close();
          navigate(`/orgs/${orgId}/projects/${project.id}/overview`);
        },
        onError: (error) => {
          const failure = classifyWriteError(error);
          // A taken slug is a 409 about ONE field. When no slug was sent the
          // server derived one from the name, so the name is what to change.
          if (failure.kind === 'conflict') {
            const field = body.slug !== undefined ? 'slug' : 'name';
            setError(field, { type: 'server', message: failure.message });
            setFocus(field);
            return;
          }
          if (failure.kind !== 'invalid') return;
          let focused = false;
          for (const issue of failure.issues) {
            const field = SERVER_FIELDS.find((candidate) => candidate === issue.field);
            if (!field) continue;
            setError(field, { type: 'server', message: issue.reason });
            if (!focused) {
              setFocus(field);
              focused = true;
            }
          }
        },
      });
    },
    () => {
      const first = SERVER_FIELDS.find((field) => errors[field]);
      if (first) setFocus(first);
    },
  );

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New project"
      description="One environment of one system. It owns its own API keys, endpoints, subscriptions and delivery ledger."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={create.isPending}>
            Create project
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-3">
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <WriteErrorNotice error={create.error} claimedFields={claimed} />
        </div>

        <Field label="Name" required error={errors.name?.message}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              placeholder="Payments"
              {...register('name', {
                required: 'A name is required.',
                minLength: {
                  value: PROJECT_NAME_MIN_LENGTH,
                  message: `At least ${PROJECT_NAME_MIN_LENGTH} character.`,
                },
                maxLength: {
                  value: PROJECT_NAME_MAX_LENGTH,
                  message: `At most ${PROJECT_NAME_MAX_LENGTH} characters.`,
                },
              })}
            />
          )}
        </Field>

        <Field
          label="Slug"
          error={errors.slug?.message}
          hint="Optional. Derived from the name when left blank; a slug you type is validated and never rewritten. Lowercase letters and digits joined by single hyphens, unique within this organization — deleted projects keep theirs."
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              mono
              aria-describedby={describedBy}
              aria-invalid={invalid}
              placeholder="payments"
              {...register('slug', {
                validate: (value) => {
                  const slug = value.trim();
                  if (slug === '') return true;
                  if (slug.length < SLUG_MIN_LENGTH) return `At least ${SLUG_MIN_LENGTH} characters.`;
                  if (slug.length > PROJECT_SLUG_MAX_LENGTH) {
                    return `At most ${PROJECT_SLUG_MAX_LENGTH} characters.`;
                  }
                  if (!SLUG_PATTERN.test(slug)) {
                    return 'Lowercase letters and digits, in groups joined by single hyphens.';
                  }
                  return true;
                },
              })}
            />
          )}
        </Field>

        <Field label="Environment" required error={errors.environment?.message}>
          {({ id, describedBy, invalid }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              options={ENVIRONMENTS}
              {...register('environment')}
            />
          )}
        </Field>

        {/*
          The production gate.
          
          Shown only when `live` is chosen, because a warning that is always on
          screen is a warning nobody reads. Three consequences, and all three
          are things people discover at the worst moment: the first event makes
          the project billable, nothing sends until each endpoint has a signing
          secret, and the publish allowlist starts empty so any valid key can
          publish from anywhere.
        */}
        {environment === 'live' && (
          <div
            role="note"
            className="flex flex-col gap-2 rounded-md border border-danger/30 bg-danger-soft/50 px-3 py-2.5 text-2xs leading-relaxed text-ink-muted"
          >
            <p className="text-2xs font-bold uppercase tracking-wide text-danger">
              What changes in production
            </p>
            <p>
              <strong className="font-semibold text-ink">
                Events count towards your usage from the first one.
              </strong>{' '}
              Every event this project accepts is metered from the moment it is created.
            </p>
            <p>
              <strong className="font-semibold text-ink">
                Nothing sends until an endpoint has a signing secret.
              </strong>{' '}
              We will not make an unsigned request, so a new endpoint stays paused until you issue
              one.
            </p>
            <p>
              <strong className="font-semibold text-ink">
                Anyone with a valid key can publish to it.
              </strong>{' '}
              The allowed-address list starts empty. Fill it in before you hand the key to
              anything.
            </p>
          </div>
        )}

        <Field
          label="Start from an existing project"
          hint="Copies endpoints with their timeouts, limits and custom headers, retry policies and subscriptions. Signing secrets, API keys and the delivery record are never copied."
          error={errors.copy_from_project_id?.message}
        >
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              options={[
                { value: '', label: 'Start from empty' },
                ...sources.map((row) => ({
                  value: row.id,
                  label: `${row.name} — ${row.environment}`,
                })),
              ]}
              {...register('copy_from_project_id')}
            />
          )}
        </Field>

        {source && (
          <div
            role="note"
            className="flex flex-col gap-2 rounded-md border border-line bg-raised/50 px-3 py-2.5 text-2xs leading-relaxed text-ink-muted"
          >
            <p>
              <strong className="font-semibold text-ink">
                Everything copied arrives paused, with no signing secret.
              </strong>{' '}
              The URLs point at {source.name}&rsquo;s servers, so nothing can reach the wrong one
              before you have looked at the list. Check every URL, issue a secret, then resume.
            </p>
            {source.environment === 'test' && environment === 'live' && (
              <p className="text-warn">
                <strong className="font-semibold">
                  You are copying a test project into a production one.
                </strong>{' '}
                Those endpoints point at test URLs. Check every one of them before you resume it.
              </p>
            )}
          </div>
        )}

        <p
          role="note"
          className="rounded-md border border-warn/30 bg-warn-soft/50 px-3 py-2 text-2xs leading-relaxed text-warn"
        >
          <strong className="font-semibold">The environment cannot be changed after creation.</strong>{' '}
          It decides which API keys authenticate against the project (
          <code className="font-mono">wk_{environment}_</code>) and which ingest traffic belongs
          to it, so the API refuses to alter it later. To move a system from test to live, create a
          second project.
        </p>
      </form>
    </Dialog>
  );
}
