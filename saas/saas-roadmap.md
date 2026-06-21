# SaaS Roadmap

## Phase 0: Local Copy

Status: started.

- Create a separate local project copy.
- Remove generated dependency folders from the copy.
- Add SaaS planning and migration files.
- Keep the original working project untouched.

## Phase 1: Single-Tenant SaaS-Ready

Goal: current customer still works as before, but all data is internally attached to an organization.

Tasks:

- Add `organizations`.
- Add `organization_members`.
- Add `organization_id` to production data.
- Create one default organization.
- Attach all existing rows/data to that organization.
- Update authentication payload to include organization memberships.
- Add backend guards for `org_admin`, `editor`, `reader`.
- Keep legacy roles temporarily for compatibility.

Exit criteria:

- Existing planner opens with current data.
- Existing users can log in.
- Editors can save plan changes.
- Readers cannot save changes.
- Data has `organization_id` everywhere important.

## Phase 2: Multi-Organization Backend

Goal: two organizations can use one deployed backend without seeing each other.

Tasks:

- Add API routes for organizations.
- Add service-admin-only routes.
- Scope plan loading by `organization_id`.
- Scope users by organization membership.
- Make user creation organization-aware.
- Add audit events for membership and role changes.

Exit criteria:

- Organization A cannot read Organization B data.
- Organization A cannot write Organization B data.
- Service admin can create and disable organizations.

## Phase 3: Frontend Tenant UX

Goal: make the current UI understand organizations without cluttering production planning screens.

Tasks:

- Add service admin screen.
- Add organization settings screen.
- Replace global user management with organization user management.
- Show organization name in the app header.
- Add feature flags per organization.

Exit criteria:

- Admin of a customer can manage only their company.
- Service admin can manage all companies.
- Feature visibility can differ by organization.

## Phase 4: Storage Hardening

Goal: prepare for paid use.

Tasks:

- Move from one large plan file to organization-scoped storage files or database tables.
- Add optimistic concurrency control per organization.
- Add daily backups.
- Add retention policy for action logs.
- Add error logging.

Exit criteria:

- A save collision cannot silently overwrite another user's changes.
- One customer's corrupted data can be restored independently.

## Phase 5: Billing And Commercialization

Goal: support paid customers.

Tasks:

- Add organization statuses: `trial`, `active`, `past_due`, `blocked`.
- Add tariff field.
- Add manual billing controls first.
- Later integrate payment provider.

Exit criteria:

- Blocked organization cannot use planner.
- Trial/active state is visible to service admin.
