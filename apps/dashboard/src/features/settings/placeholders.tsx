import { Link, useParams } from 'react-router-dom';
import { EmptyState, PageHeader, Panel, Placeholder } from '../../components';

/**
 * What is left of this file.
 *
 * Project and organization settings used to live here as read-only panels,
 * because `PATCH /v1/projects/:id` and `PATCH /v1/organizations/:id` were
 * believed not to exist. They do — both were mounted and unwired — so those two
 * pages are now real forms in `ProjectSettingsPage.tsx` and
 * `OrganizationSettingsPage.tsx`. Billing is the only genuine placeholder left.
 */

/**
 * Billing genuinely has no backend — no route, no shape, not even in the mock.
 * So it stays an honest empty state rather than a fabricated invoice table, and
 * it sends the operator to Usage, which has real numbers.
 */
export function BillingPage() {
  const { orgId = '' } = useParams();

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Billing" description="Plan, payment method and invoices." />

      <Panel>
        <EmptyState
          title="Billing is not built yet"
          description={
            <>
              <p className="mb-2">
                There is no billing route on the control API — not a stub, not a shape. Nothing on
                this page is real, so nothing is shown.
              </p>
              <p>
                Metered volume for the current period is already available on{' '}
                <Link to={`/orgs/${orgId}/usage`} className="text-accent hover:underline">
                  Usage
                </Link>
                , which is what an invoice would be calculated from.
              </p>
            </>
          }
        />
      </Panel>

      <Placeholder
        title="Billing"
        planned={[
          'Current plan and included event volume',
          'Payment method',
          'Invoice history and downloadable receipts',
          'Overage alerts before the period closes',
        ]}
      />
    </div>
  );
}
