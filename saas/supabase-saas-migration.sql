-- SaaS migration draft for Brew Planner.
-- Purpose: convert the current single-tenant schema into a multi-tenant schema.
-- Review before running in production.

begin;

create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  status text not null default 'active',
  tariff text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_status_check check (status in ('trial', 'active', 'past_due', 'blocked')),
  constraint organizations_tariff_check check (tariff in ('manual', 'basic', 'pro', 'enterprise'))
);

create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'reader',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_members_role_check check (role in ('org_admin', 'editor', 'reader')),
  constraint organization_members_unique_user_org unique (organization_id, user_id)
);

alter table public.user_profiles
  add column if not exists display_name text not null default '',
  add column if not exists service_role text not null default 'user';

alter table public.user_profiles
  drop constraint if exists user_profiles_role;

alter table public.user_profiles
  add constraint user_profiles_service_role_check check (service_role in ('user', 'super_admin'));

insert into public.organizations (name, slug, status, tariff)
values ('Default Organization', 'default', 'active', 'manual')
on conflict (slug) do nothing;

alter table public.production_sites
  add column if not exists organization_id uuid references public.organizations(id);

alter table public.tanks
  add column if not exists organization_id uuid references public.organizations(id);

alter table public.product_templates
  add column if not exists organization_id uuid references public.organizations(id);

alter table public.production_cycles
  add column if not exists organization_id uuid references public.organizations(id);

alter table public.cycle_comments
  add column if not exists organization_id uuid references public.organizations(id);

alter table public.action_logs
  add column if not exists organization_id uuid references public.organizations(id);

with default_org as (
  select id from public.organizations where slug = 'default'
)
update public.production_sites
set organization_id = (select id from default_org)
where organization_id is null;

with default_org as (
  select id from public.organizations where slug = 'default'
)
update public.tanks
set organization_id = (select id from default_org)
where organization_id is null;

with default_org as (
  select id from public.organizations where slug = 'default'
)
update public.product_templates
set organization_id = (select id from default_org)
where organization_id is null;

with default_org as (
  select id from public.organizations where slug = 'default'
)
update public.production_cycles
set organization_id = (select id from default_org)
where organization_id is null;

with default_org as (
  select id from public.organizations where slug = 'default'
)
update public.cycle_comments
set organization_id = (select id from default_org)
where organization_id is null;

with default_org as (
  select id from public.organizations where slug = 'default'
)
update public.action_logs
set organization_id = (select id from default_org)
where organization_id is null;

with default_org as (
  select id from public.organizations where slug = 'default'
)
insert into public.organization_members (organization_id, user_id, role)
select
  (select id from default_org),
  id,
  case
    when role = 'admin' then 'org_admin'
    when role = 'manager' then 'editor'
    else 'reader'
  end
from public.user_profiles
on conflict (organization_id, user_id) do nothing;

alter table public.production_sites
  alter column organization_id set not null;

alter table public.tanks
  alter column organization_id set not null;

alter table public.product_templates
  alter column organization_id set not null;

alter table public.production_cycles
  alter column organization_id set not null;

alter table public.cycle_comments
  alter column organization_id set not null;

create unique index if not exists product_templates_org_name_unique
on public.product_templates (organization_id, lower(name));

create index if not exists production_sites_org_idx
on public.production_sites (organization_id);

create index if not exists tanks_org_site_idx
on public.tanks (organization_id, site_id);

create index if not exists production_cycles_org_dates_idx
on public.production_cycles (organization_id, start_date, end_date);

create index if not exists cycle_comments_org_cycle_idx
on public.cycle_comments (organization_id, cycle_id);

create index if not exists action_logs_org_created_idx
on public.action_logs (organization_id, created_at desc);

commit;
