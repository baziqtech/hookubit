import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import type { AcceptInvitationBody, AcceptedInvitation } from '../../types/api';

/**
 * Redeems the token from the invitation email at `POST /v1/invitations/accept`.
 *
 * The route requires a session — the token proves a mailbox, the session
 * proves who is asking, and the server refuses unless they match — so the
 * caller must already have `useSession` answered before firing this. The
 * token is single-use, and the server CONSUMES IT BEFORE checking the address
 * or the inviter's rank: any refusal burns it, and the inviter has to send a
 * new one. Send it exactly once — see the mount guard in `AcceptInvitationPage`.
 *
 * On success the organizations list is invalidated: the switcher and
 * `RootRedirect` read that list, and the org just joined must be on it.
 */
export function useAcceptInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AcceptInvitationBody) =>
      api.post<AcceptedInvitation>('/v1/invitations/accept', body),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.organizationsRoot() }),
  });
}
