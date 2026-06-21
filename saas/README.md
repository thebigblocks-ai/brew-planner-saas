# Brew Planner SaaS Migration

This local copy is the starting point for turning Brew Planner from a single-company planner into a multi-tenant SaaS product.

## Current Goal

Keep the existing planner behavior intact, but introduce the data model and backend boundaries needed for many independent organizations.

## Target Model

- One frontend application.
- One API/backend.
- One shared storage/database layer.
- Every customer account is an `organization`.
- Every business entity belongs to exactly one organization.
- Users can only read or modify data for organizations where they are members.

## Role Model

Service-level role:

- `super_admin`: service owner/operator. Can manage all organizations.

Organization-level roles:

- `org_admin`: manages one organization and its users.
- `editor`: edits production planning data.
- `reader`: reads production planning data only.

Legacy role mapping:

- `admin` -> `org_admin`
- `manager` -> `editor`
- `reader` -> `reader`

## First Migration Phase

Phase 1 is intentionally conservative:

1. Create one default organization for the current production data.
2. Add `organization_id` to production sites, tanks, cycles, templates, comments, action logs and feature flags.
3. Add organization membership records for existing users.
4. Keep the current UI behavior unchanged.
5. Make backend/API reads and writes organization-scoped.

## Files Added In This Folder

- `saas/README.md`: this handoff note.
- `saas/saas-roadmap.md`: phased migration plan.
- `saas/supabase-saas-migration.sql`: Supabase migration draft for multi-tenant data.
- `saas/yandex-json-model.md`: Yandex Object Storage JSON model for a SaaS-ready backend.

## First Implemented SaaS Pieces

- `admin.html`: separate service administration cabinet for `super_admin` users.
- `/organizations`: service-admin API for organizations.
- `/organizations/:id/features`: feature flags per organization.
- `/organizations/:id/users`: organization user administration.
- `/tickets`: helpdesk tickets. Email notifications are intentionally not implemented yet.
- `index.html` redirects `super_admin` users to `admin.html`, so the service admin cabinet does not load the planner.

## Important Rule

Do not trust the frontend for tenant isolation. The backend must derive the active organization from the authenticated user/session and apply it to every read/write operation.
