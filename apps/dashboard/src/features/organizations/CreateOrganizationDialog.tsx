import { useId } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, Field, Input, WriteErrorNotice } from '../../components';
import { classifyWriteError } from '../../lib/api-errors';
import { useFocusOnError } from '../../lib/use-focus-on-error';
import {
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_NAME_MIN_LENGTH,
  ORGANIZATION_SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
  type CreateOrganizationBody,
} from '../../types/api';
import { useCreateOrganization } from './api';

/**
 * `POST /v1/organizations` from the organization switcher: a name and an
 * optional slug, which is all `CreateOrganizationDto` takes. The caller
 * becomes the owner. On success the operator lands on the new organization,
 * which has no projects yet - the empty state there offers the next step.
 *
 * A taken explicit slug is a 409 `conflict` about ONE field and lands under
 * the slug input; the per-account ceiling is `limit_exceeded` and lands in
 * the panel, because nothing on this form fixes it.
 */
type FormValues = { name: string; slug: string };

const SERVER_FIELDS: readonly (keyof FormValues)[] = ['name', 'slug'];

export function CreateOrganizationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const formId = useId();
  const navigate = useNavigate();
  const create = useCreateOrganization();
  const errorRef = useFocusOnError(create.isError);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<FormValues>({ defaultValues: { name: '', slug: '' } });

  const claimed = SERVER_FIELDS.filter((field) => errors[field]?.type === 'server');

  const close = () => {
    reset();
    create.reset();
    onClose();
  };

  const onSubmit = handleSubmit(
    (values) => {
      const body: CreateOrganizationBody = { name: values.name.trim() };
      const slug = values.slug.trim();
      if (slug) body.slug = slug;

      create.mutate(body, {
        onSuccess: (organization) => {
          close();
          navigate(`/orgs/${organization.id}`);
        },
        onError: (error) => {
          const failure = classifyWriteError(error);
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
      title="New organization"
      description="The billing and people boundary every project sits inside. You become its owner."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={create.isPending}>
            Create organization
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
              placeholder="Acme"
              {...register('name', {
                required: 'A name is required.',
                minLength: {
                  value: ORGANIZATION_NAME_MIN_LENGTH,
                  message: `At least ${ORGANIZATION_NAME_MIN_LENGTH} characters.`,
                },
                maxLength: {
                  value: ORGANIZATION_NAME_MAX_LENGTH,
                  message: `At most ${ORGANIZATION_NAME_MAX_LENGTH} characters.`,
                },
              })}
            />
          )}
        </Field>

        <Field
          label="Slug"
          error={errors.slug?.message}
          hint="Optional. Derived from the name when left blank, with a random suffix if that name is taken; a slug you type is validated and never rewritten. Unique across the whole platform."
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              mono
              aria-describedby={describedBy}
              aria-invalid={invalid}
              placeholder="acme"
              {...register('slug', {
                validate: (value) => {
                  const slug = value.trim();
                  if (slug === '') return true;
                  if (slug.length < SLUG_MIN_LENGTH) return `At least ${SLUG_MIN_LENGTH} characters.`;
                  if (slug.length > ORGANIZATION_SLUG_MAX_LENGTH) {
                    return `At most ${ORGANIZATION_SLUG_MAX_LENGTH} characters.`;
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
      </form>
    </Dialog>
  );
}
