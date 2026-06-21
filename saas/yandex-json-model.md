# SaaS-Ready Yandex JSON Storage Model

This is a transitional model if the SaaS backend continues to use Yandex Object Storage instead of a relational database.

## Storage Layout

```text
brew-planner/
  organizations.json
  users.json
  memberships.json
  orgs/
    <organization-id>/
      plan.json
      action-logs.json
      presence.json
      backups/
        plan-YYYY-MM-DD.json
```

## organizations.json

```json
[
  {
    "id": "org_...",
    "name": "Bakunin Brewery",
    "slug": "bakunin",
    "status": "active",
    "tariff": "manual",
    "features": {
      "partialBottlings": true,
      "warehouseCalendar": true,
      "cycleSources": true
    },
    "createdAt": "2026-06-21T00:00:00.000Z"
  }
]
```

## users.json

Users are global identities.

```json
[
  {
    "id": "user_...",
    "email": "admin@example.com",
    "displayName": "Admin User",
    "serviceRole": "user",
    "passwordHash": "...",
    "createdAt": "2026-06-21T00:00:00.000Z"
  }
]
```

## memberships.json

Organization access is stored separately from identity.

```json
[
  {
    "id": "membership_...",
    "organizationId": "org_...",
    "userId": "user_...",
    "role": "org_admin",
    "createdAt": "2026-06-21T00:00:00.000Z"
  }
]
```

## orgs/<organization-id>/plan.json

The current `plan.json` shape can remain nearly unchanged during the first phase.

```json
{
  "organizationId": "org_...",
  "sites": [],
  "tanks": [],
  "cycles": [],
  "productTemplates": [],
  "features": {},
  "revision": 1,
  "updatedAt": "2026-06-21T00:00:00.000Z"
}
```

## Backend Rules

- Login returns the user's memberships.
- The active organization must be selected from memberships, not arbitrary frontend input.
- Every plan read uses `orgs/<organization-id>/plan.json`.
- Every write checks the user's membership role.
- `reader` cannot write.
- `editor` can edit plan data.
- `org_admin` can edit plan data and organization users.
- `super_admin` can manage organizations.

## Why This Is Transitional

This layout is easier to migrate from the current Yandex-only prototype, but it is not the ideal long-term SaaS storage model. A relational database is safer for concurrency, access control, reporting and future billing.
