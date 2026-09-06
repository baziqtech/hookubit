import { PageHeader, Placeholder } from '../../components';

/**
 * Routes that exist and are navigable, but whose feature has not been built.
 * Keeping them here — rather than as eight near-identical files — makes it
 * obvious what is still outstanding.
 */
function Stub({ title, description, planned }: { title: string; description: string; planned: string[] }) {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={title} description={description} />
      <Placeholder title={title} planned={planned} />
    </div>
  );
}

export function ProjectSettingsPage() {
  return (
    <Stub
      title="Project settings"
      description="Retry policy, rate limits, retention and signing configuration."
      planned={[
        'Retry policy: max attempts, backoff strategy, jitter',
        'Project-wide rate limit and per-endpoint overrides',
        'Payload retention window',
        'Rename, transfer, and delete the project',
      ]}
    />
  );
}

export function ProjectAnalyticsPage() {
  return (
    <Stub
      title="Analytics"
      description="Delivery volume, success rate and latency over time."
      planned={[
        'Throughput and success rate over 24h / 7d / 30d',
        'p50 / p95 / p99 endpoint latency',
        'Breakdown by endpoint and by event type',
        'Top failure reasons and status codes',
      ]}
    />
  );
}

export function OrganizationSettingsPage() {
  return (
    <Stub
      title="Organization settings"
      description="Name, slug, and organization-wide defaults."
      planned={[
        'Rename the organization and change its slug',
        'Default project settings for new projects',
        'SSO configuration (OIDC / SAML)',
        'Delete the organization',
      ]}
    />
  );
}

export function BillingPage() {
  return (
    <Stub
      title="Billing"
      description="Plan, payment method and invoices."
      planned={[
        'Current plan and included volume',
        'Payment method',
        'Invoice history',
        'Overage alerts',
      ]}
    />
  );
}
