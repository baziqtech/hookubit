import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import type {
  Acknowledged,
  ForgotPasswordBody,
  LoginBody,
  RegisterBody,
  RegistrationAccepted,
  ResendVerificationBody,
  ResetPasswordBody,
  Session,
  VerifyEmailBody,
} from '../../types/api';

/**
 * The session is read from the server on every load. There is nothing to read
 * locally by design: the session is an HTTP-only cookie, so the only way to
 * know whether it is valid is to ask (ARCHITECTURE.md 9).
 */
export function useSession() {
  return useQuery({
    queryKey: queryKeys.session(),
    queryFn: () => api.get<Session>('/v1/auth/session'),
    // A 401 here is the answer, not a failure worth retrying.
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginBody) => api.post<Session>('/v1/auth/login', body),
    onSuccess: (session) => queryClient.setQueryData(queryKeys.session(), session),
  });
}

/**
 * Registration does NOT authenticate. The control plane answers an
 * unconditional 202 with no session cookie, the same for a free address and a
 * taken one, so the response cannot be used to enumerate accounts. There is
 * therefore no session to cache here and nowhere to redirect to: the user
 * verifies via the emailed link and then logs in normally.
 */
export function useRegister() {
  return useMutation({
    mutationFn: (body: RegisterBody) =>
      api.post<RegistrationAccepted>('/v1/auth/register', body),
  });
}

/**
 * Consumes the token from the verification email.
 *
 * The response is a `SessionResponseDto`, but that is the SHAPE, not a
 * session: `AuthController.verifyEmail` takes the body only — no `@Res`, so
 * no cookie is set — and the user it returns is the freshly verified record
 * for the page to show. That is why this hook does NOT write to the session
 * query the way `useLogin` does: caching a user here would make
 * `RequireSession` believe someone is signed in until its next refetch met a
 * 401. The verified page sends them to sign in instead.
 *
 * The token is single-use, so the caller must send it exactly once — see the
 * mount guard in `VerifyEmailPage`.
 */
export function useVerifyEmail() {
  return useMutation({
    mutationFn: (body: VerifyEmailBody) => api.post<Session>('/v1/auth/verify-email', body),
  });
}

/**
 * Always a 202, identically for every address, and rate limited per address
 * AND per IP because it sends mail. Nothing in the response says whether the
 * address is registered, so no caller may word its acknowledgement as if it
 * did — see `ResendAcknowledgement`.
 */
export function useResendVerification() {
  return useMutation({
    mutationFn: (body: ResendVerificationBody) =>
      api.post<Acknowledged>('/v1/auth/resend-verification', body),
  });
}

/**
 * Records that the calling user finished or skipped the product tour.
 *
 * A 204 with no body: the server sets `onboarding_completed_at` on the
 * FIRST call and leaves it alone on every replay, and says to read the instant
 * back from `GET /v1/auth/session`. So the cached session is patched
 * optimistically — the tour must not reappear during the refetch — and then
 * invalidated, so the timestamp shown anywhere is the one the server recorded
 * rather than the browser's clock.
 */
export function useCompleteOnboarding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/v1/auth/onboarding-completed'),
    onSuccess: () => {
      queryClient.setQueryData<Session>(queryKeys.session(), (current) =>
        current && current.user.onboarding_completed_at === null
          ? {
              ...current,
              user: { ...current.user, onboarding_completed_at: new Date().toISOString() },
            }
          : current,
      );
      return queryClient.invalidateQueries({ queryKey: queryKeys.session() });
    },
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (body: ForgotPasswordBody) =>
      api.post<{ status: string }>('/v1/auth/forgot-password', body),
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: (body: ResetPasswordBody) =>
      api.post<{ status: string }>('/v1/auth/reset-password', body),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/v1/auth/logout'),
    // Drop every cached tenant-scoped response on the way out.
    onSuccess: () => queryClient.clear(),
  });
}
