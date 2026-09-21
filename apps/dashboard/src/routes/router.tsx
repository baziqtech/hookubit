import { createBrowserRouter, Navigate } from 'react-router-dom';
import { ApiKeysPage } from '../features/api-keys/ApiKeysPage';
import { AuditPage } from '../features/audit/AuditPage';
import { ForgotPasswordPage } from '../features/auth/ForgotPasswordPage';
import { LoginPage } from '../features/auth/LoginPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { ResetPasswordPage } from '../features/auth/ResetPasswordPage';
import { VerifyEmailPage } from '../features/auth/VerifyEmailPage';
import { DeliveriesPage } from '../features/deliveries/DeliveriesPage';
import { DeliveryDetailPage } from '../features/deliveries/DeliveryDetailPage';
import { OutboxPage } from '../features/outbox/OutboxPage';
import { EndpointDetailPage } from '../features/endpoints/EndpointDetailPage';
import { EndpointsPage } from '../features/endpoints/EndpointsPage';
import { EventDetailPage } from '../features/events/EventDetailPage';
import { EventsPage } from '../features/events/EventsPage';
import { GetStartedPage } from '../features/onboarding/GetStartedPage';
import { OverviewPage } from '../features/overview/OverviewPage';
import { PoliciesPage } from '../features/policies/PoliciesPage';
import { AnalyticsPage } from '../features/analytics/AnalyticsPage';
import { OrganizationSettingsPage } from '../features/settings/OrganizationSettingsPage';
import { ProjectSettingsPage } from '../features/settings/ProjectSettingsPage';
import { BillingPage } from '../features/settings/placeholders';
import { SubscriptionsPage } from '../features/subscriptions/SubscriptionsPage';
import { AcceptInvitationPage } from '../features/team/AcceptInvitationPage';
import { TeamPage } from '../features/team/TeamPage';
import { UsagePage } from '../features/usage/UsagePage';
import { AppLayout } from '../layouts/AppLayout';
import { AuthLayout } from '../layouts/AuthLayout';
import { NotFoundPage, OrganizationLanding, RootRedirect } from './LandingRoutes';
import { RequireSession } from './RequireSession';

/**
 * The full route tree (ARCHITECTURE.md 5).
 *
 * Tenancy is in the path, not in ambient state: `/orgs/:orgId/projects/:projectId/…`
 * means every screen is linkable, every query key is derivable from the URL,
 * and pasting a link into an incident channel lands the next person on exactly
 * what you were looking at.
 */
export const router = createBrowserRouter([
  {
    element: <AuthLayout />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
      { path: '/reset-password', element: <ResetPasswordPage /> },
      // Where the verification email lands: `${DASHBOARD_URL}/verify-email?token=…`.
      { path: '/verify-email', element: <VerifyEmailPage /> },
      // Where the invitation email lands: `${DASHBOARD_URL}/accept-invitation?token=…`.
      // Outside `RequireSession` on purpose: an invitee often has no session yet,
      // and the page itself decides whether to redeem or to send them to sign in
      // with the token kept.
      { path: '/accept-invitation', element: <AcceptInvitationPage /> },
    ],
  },
  {
    element: <RequireSession />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: '/', element: <RootRedirect /> },
          { path: '/orgs', element: <RootRedirect /> },

          { path: '/orgs/:orgId', element: <OrganizationLanding /> },
          { path: '/orgs/:orgId/settings', element: <OrganizationSettingsPage /> },
          { path: '/orgs/:orgId/team', element: <TeamPage /> },
          { path: '/orgs/:orgId/billing', element: <BillingPage /> },
          { path: '/orgs/:orgId/usage', element: <UsagePage /> },
          { path: '/orgs/:orgId/audit', element: <AuditPage /> },

          {
            path: '/orgs/:orgId/projects/:projectId',
            children: [
              { index: true, element: <Navigate to="overview" replace /> },
              { path: 'get-started', element: <GetStartedPage /> },
              { path: 'overview', element: <OverviewPage /> },
              { path: 'events', element: <EventsPage /> },
              { path: 'events/:eventId', element: <EventDetailPage /> },
              { path: 'deliveries', element: <DeliveriesPage /> },
              { path: 'deliveries/:deliveryId', element: <DeliveryDetailPage /> },
              { path: 'outbox', element: <OutboxPage /> },
              { path: 'endpoints', element: <EndpointsPage /> },
              { path: 'endpoints/:endpointId', element: <EndpointDetailPage /> },
              { path: 'subscriptions', element: <SubscriptionsPage /> },
              { path: 'policies', element: <PoliciesPage /> },
              { path: 'api-keys', element: <ApiKeysPage /> },
              { path: 'analytics', element: <AnalyticsPage /> },
              { path: 'settings', element: <ProjectSettingsPage /> },
            ],
          },

          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
