import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import type {
  ForgotPasswordBody,
  LoginBody,
  RegisterBody,
  RegistrationAccepted,
  ResetPasswordBody,
  Session,
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
