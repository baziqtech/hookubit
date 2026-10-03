import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Panel } from '../../components';
import { ApiRequestError } from '../../lib/api';
import { Wordmark } from '../auth/Wordmark';
import { useConfirmDestination } from './api';

/**
 * Where a confirmation link lands.
 *
 * ## Why it is outside the app shell and outside the session guard
 *
 * The person clicking is very often not a member of the organization that added
 * the address — that is the entire point of using a group address. Putting this
 * behind a sign-in would make the feature unusable for the case it exists for,
 * and dropping them into a project shell they have no access to would be worse
 * than useless.
 *
 * ## Why it redeems on mount
 *
 * The click IS the consent. Asking again on this page ("are you sure?") adds a
 * step for somebody who has already made the decision, in a context where they
 * may well never visit this product again.
 */
export function ConfirmNotificationsPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const confirm = useConfirmDestination();

  /*
   * Redeem ONCE, keyed on the token.
   *
   * `confirm` is deliberately not a dependency. The token is single use, so a
   * re-run would attempt to redeem a spent one and show a failure to somebody
   * who had just succeeded — and `useMutation` returns a new object identity
   * on every state change, so including it would guarantee exactly that.
   */
  const redeem = confirm.mutate;
  useEffect(() => {
    if (!token) return;
    redeem(token);
  }, [token, redeem]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-6">
      <Wordmark />

      <Panel>
        {!token ? (
          <Message
            title="This link is incomplete"
            body="It is missing its token. Copy the whole link out of the message, including everything after the question mark."
          />
        ) : confirm.isPending ? (
          <Message title="Confirming…" body="One moment." />
        ) : confirm.isSuccess ? (
          <Message
            title={`${confirm.data.target} will now receive alerts`}
            body={`This address is confirmed for the ${confirm.data.project_name} project. It will be told when an endpoint is stopped, and nothing routine — we do not send anything you do not have to act on.`}
          />
        ) : (
          <Message
            title="This link is not valid"
            body={
              confirm.error instanceof ApiRequestError
                ? confirm.error.body.message
                : 'It may have already been used, or it may have expired. Ask whoever added this address for a new one.'
            }
          />
        )}
      </Panel>

      <p className="text-center text-2xs text-ink-subtle">
        <Link to="/login" className="text-accent hover:underline">
          Sign in to HookuBit
        </Link>{' '}
        if you have an account here.
      </p>
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-title font-semibold text-ink">{title}</h1>
      <p className="text-xs leading-relaxed text-ink-muted">{body}</p>
    </div>
  );
}
