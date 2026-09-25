import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { Async } from '../../components';
import type { Project } from '../../types/api';
import { useProjects } from '../projects/api';
import type { AnalyticsWindowKey } from './window';

/**
 * `/orgs/:orgId/usage` — kept, because people bookmarked it.
 *
 * Usage is a tab on Analytics now, and Analytics is project-scoped, so this
 * route cannot simply be re-pointed: it has an organization in its path and no
 * project. It resolves a project and lands on that project's Usage tab.
 *
 * ## The project it lands on is not cosmetic
 *
 * It used to be, when Usage was an organization-scoped page of its own: the
 * rail rendered the no-project groups and the address could not point anywhere
 * wrong. It is not cosmetic now. `AppLayout` builds the whole left rail from the
 * `:projectId` in the path, so the project this redirect picks becomes the
 * project that Deliveries, Events, Endpoints and Subscriptions point at, and the
 * one the project card names. An operator who was working in Rides, opened
 * Billing (an organization-scoped screen, which drops the project), and followed
 * the Usage link would be re-anchored to whichever project happens to be first —
 * and their next rail click would show that project's data.
 *
 * So the choice is DECLARED rather than made quietly. Two parts:
 *
 * 1. A project named in the incoming address wins. `?project=<id>` — validated
 *    against the organization's projects, because an id from a stale bookmark
 *    must not anchor the rail to something that is not there — is the visitor's
 *    own choice and is followed without comment.
 * 2. When there is no such id, the first project is picked as before, and the
 *    redirect says so: it carries `anchor=auto`, which `AnalyticsPage` renders
 *    as a visible note naming the project it settled on. The Usage table is
 *    organization-wide either way; it is the CONTEXT AROUND IT that now belongs
 *    to one project, and that is the part a visitor cannot otherwise see.
 *
 * An organization with ONE project is not that case: there was no alternative to
 * pick and the rail cannot be pointing anywhere else, so it gets no note. A
 * warning about a decision that could not have gone otherwise is how a warning
 * becomes something people scroll past.
 *
 * The window is pinned to `30d` on purpose. The old page had no selector and
 * was hard-coded to 720 hours, so a bookmark of it meant "the last 30 days by
 * project". Landing on the page's 24h default would quietly answer a different
 * question with the same-looking table.
 *
 * With no projects there is no usage and nothing to show: `/orgs/:orgId` is
 * where an operator in that position needs to be, and it already explains why
 * the organization is empty and offers the way out of it.
 */
const USAGE_BOOKMARK_WINDOW: AnalyticsWindowKey = '30d';

/** `?project=` on `/orgs/:orgId/usage`: the visitor's own anchor, if they had one. */
export const USAGE_PROJECT_HINT_PARAM = 'project';

/**
 * `?anchor=auto` on the redirect's target: "the project in this address was
 * chosen for you, not by you". The one flag `AnalyticsPage` needs to tell a
 * deliberate visit from a re-anchored one.
 */
export const ANCHOR_PARAM = 'anchor';
export const ANCHOR_CHOSEN_FOR_VISITOR = 'auto';

export function anchorWasChosenForVisitor(raw: string | null | undefined): boolean {
  return raw === ANCHOR_CHOSEN_FOR_VISITOR;
}

export function usageRedirectPath(
  orgId: string,
  projectId: string,
  options: { chosenForVisitor?: boolean } = {},
): string {
  const anchor = options.chosenForVisitor ? `&${ANCHOR_PARAM}=${ANCHOR_CHOSEN_FOR_VISITOR}` : '';
  return `/orgs/${orgId}/projects/${projectId}/analytics?tab=usage&window=${USAGE_BOOKMARK_WINDOW}${anchor}`;
}

/**
 * Which project the address will name, and whether the visitor picked it.
 *
 * A pure function because the honesty of the redirect turns on exactly this
 * decision and it is worth asserting directly: a stale `?project=` is NOT
 * followed — it would anchor the rail to a project that is not in the
 * organization — but falling back to the first one then counts as a choice made
 * for the visitor, and is declared as one.
 */
export function chooseUsageAnchor(
  rows: Project[],
  requested: string | null | undefined,
): { projectId: string; chosenForVisitor: boolean } | null {
  if (rows.length === 0) return null;
  const asked = requested ? rows.find((row) => row.id === requested) : undefined;
  return {
    projectId: (asked ?? rows[0]).id,
    // Declared only when the choice could have gone another way: one project is
    // no choice, and the note would be telling an operator they were moved to
    // the only place there is.
    chosenForVisitor: !asked && rows.length > 1,
  };
}

export function UsageRedirect() {
  const { orgId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const requested = searchParams.get(USAGE_PROJECT_HINT_PARAM);
  const projects = useProjects(orgId);

  return (
    <Async query={projects}>
      {(page) => {
        const anchor = chooseUsageAnchor(page.rows, requested);
        if (!anchor) return <Navigate to={`/orgs/${orgId}`} replace />;

        return (
          <Navigate
            to={usageRedirectPath(orgId, anchor.projectId, {
              chosenForVisitor: anchor.chosenForVisitor,
            })}
            replace
          />
        );
      }}
    </Async>
  );
}
