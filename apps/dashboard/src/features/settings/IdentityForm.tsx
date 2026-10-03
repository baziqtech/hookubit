import { useEffect, useRef, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Button, Field, Input, WriteErrorNotice } from '../../components';
import { classifyWriteError } from '../../lib/api-errors';
import { SLUG_MIN_LENGTH, SLUG_PATTERN } from '../../types/api';

export interface IdentityValues {
  name: string;
  slug: string;
}

/**
 * The name-and-slug form both settings pages are.
 *
 * `PATCH /v1/organizations/:orgId` and
 * `PATCH /v1/organizations/:orgId/projects/:projectId` accept the same two
 * fields and refuse everything else — the global `ValidationPipe` runs
 * `forbidNonWhitelisted`, so a stray key is a 400 rather than an ignored field.
 * The two pages differ only in their length ceilings (a slug is 48 characters
 * on an organization and 64 on a project) and in what else is worth saying
 * around the form, so the form itself is one component.
 *
 * ## Only what changed is sent
 *
 * A PATCH that restates the slug it already has is a request that can 409 on
 * itself. Sending the diff means renaming does not risk a conflict on a slug
 * nobody touched.
 */
export function IdentityForm({
  values,
  nameLabel,
  nameMin,
  nameMax,
  slugMax,
  slugHint,
  mutation,
  children,
}: {
  values: IdentityValues;
  nameLabel: string;
  nameMin: number;
  nameMax: number;
  slugMax: number;
  slugHint: ReactNode;
  mutation: {
    mutate: (
      body: Partial<IdentityValues>,
      options?: { onError?: (error: unknown) => void },
    ) => void;
    isPending: boolean;
    isError: boolean;
    isSuccess: boolean;
    error: unknown;
  };
  /** Read-only facts, rendered under the editable pair. */
  children?: ReactNode;
}) {
  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors, isDirty },
  } = useForm<IdentityValues>({ values });
  const errorRef = useRef<HTMLDivElement>(null);
  const claimed = (['name', 'slug'] as const).filter((field) => errors[field]);

  // Only when the failure belongs to no single input. If `onError` placed it on
  // the slug, the caret is already there and moving it back to a panel that is
  // rendering nothing would undo the one useful thing that happened.
  useEffect(() => {
    if (mutation.isError && claimed.length === 0) errorRef.current?.focus();
  }, [mutation.isError, claimed.length]);

  const onSubmit = handleSubmit(
    (submitted) => {
      const body: Partial<IdentityValues> = {};
      if (submitted.name.trim() !== values.name) body.name = submitted.name.trim();
      if (submitted.slug.trim() !== values.slug) body.slug = submitted.slug.trim();
      if (Object.keys(body).length === 0) return;

      mutation.mutate(body, {
        onError: (error) => {
          const failure = classifyWriteError(error);
          // A taken slug is a 409 `conflict`, and it is about ONE field. Put it
          // under that field rather than in a panel that says only "that
          // conflicts with something".
          if (failure.kind === 'conflict' && body.slug !== undefined) {
            setError('slug', { type: 'server', message: failure.message });
            setFocus('slug');
            return;
          }
          if (failure.kind !== 'invalid') return;
          let focused = false;
          for (const issue of failure.issues) {
            if (issue.field !== 'name' && issue.field !== 'slug') continue;
            setError(issue.field, { type: 'server', message: issue.reason });
            if (!focused) {
              setFocus(issue.field);
              focused = true;
            }
          }
        },
      });
    },
    () => setFocus(errors.name ? 'name' : 'slug'),
  );

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div ref={errorRef} tabIndex={-1} className="outline-none">
        <WriteErrorNotice error={mutation.error} claimedFields={claimed} />
      </div>

      <Field label={nameLabel} required error={errors.name?.message}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            {...register('name', {
              required: 'A name is required.',
              minLength: { value: nameMin, message: `At least ${nameMin} characters.` },
              maxLength: { value: nameMax, message: `At most ${nameMax} characters.` },
            })}
          />
        )}
      </Field>

      <Field label="Slug" required error={errors.slug?.message} hint={slugHint}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            mono
            aria-describedby={describedBy}
            aria-invalid={invalid}
            {...register('slug', {
              required: 'A slug is required.',
              minLength: { value: SLUG_MIN_LENGTH, message: `At least ${SLUG_MIN_LENGTH} characters.` },
              maxLength: { value: slugMax, message: `At most ${slugMax} characters.` },
              pattern: {
                value: SLUG_PATTERN,
                message: 'Lowercase letters and digits, in groups joined by single hyphens.',
              },
            })}
          />
        )}
      </Field>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" loading={mutation.isPending} disabled={!isDirty}>
          Save changes
        </Button>
        {/*
          A save with nothing to save is not an error, so the button is simply
          inert and says why. `role="status"` announces the confirmation without
          stealing focus from wherever the user went next.
        */}
        {!isDirty && !mutation.isPending && (
          <span role="status" className="text-2xs text-ink-subtle">
            {mutation.isSuccess ? 'Saved.' : 'No changes yet.'}
          </span>
        )}
      </div>

      {children}
    </form>
  );
}
