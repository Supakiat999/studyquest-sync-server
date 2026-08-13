create table if not exists accounts (
  username text primary key,
  display_name text not null,
  password_record jsonb not null,
  state jsonb,
  state_bytes integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table accounts add column if not exists state_revision bigint not null default 0;
alter table accounts add column if not exists state_updated_at timestamptz;
alter table accounts add column if not exists state_hash text;
alter table accounts add column if not exists password_change_required boolean not null default false;
alter table accounts add column if not exists temporary_password_expires_at timestamptz;

create table if not exists sessions (
  token_hash text primary key,
  username text not null references accounts(username) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);

create index if not exists sessions_username_idx on sessions(username);
create index if not exists sessions_expires_at_idx on sessions(expires_at);

create table if not exists state_backups (
  id bigserial primary key,
  username text not null references accounts(username) on delete cascade,
  revision bigint not null,
  state jsonb not null,
  reason text not null default 'daily',
  created_at timestamptz not null default now()
);

create index if not exists state_backups_username_created_idx on state_backups(username, created_at desc);

create table if not exists state_versions (
  id bigserial primary key,
  username text not null references accounts(username) on delete cascade,
  revision bigint not null,
  state_gzip bytea not null,
  state_hash text not null,
  state_bytes integer not null,
  compressed_bytes integer not null,
  source_device text,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (username, revision)
);

create index if not exists state_versions_username_created_idx
  on state_versions(username, created_at desc);
create index if not exists state_versions_username_hash_idx
  on state_versions(username, state_hash);

create table if not exists state_save_events (
  id bigserial primary key,
  username text not null references accounts(username) on delete cascade,
  result text not null
    check (result in ('accepted', 'no_change', 'conflicted', 'rejected', 'oversized', 'restored', 'recovered')),
  base_revision bigint,
  current_revision bigint,
  resulting_revision bigint,
  state_hash text,
  state_bytes integer,
  device_id text,
  summary jsonb,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists state_save_events_username_created_idx
  on state_save_events(username, created_at desc);
create index if not exists state_save_events_result_created_idx
  on state_save_events(result, created_at desc);

alter table state_save_events add column if not exists base_hash text;
alter table state_save_events add column if not exists mutation_id text;
alter table state_save_events add column if not exists change_manifest jsonb;

create unique index if not exists state_save_events_mutation_result_idx
  on state_save_events(username, mutation_id)
  where mutation_id is not null and resulting_revision is not null;

create table if not exists sync_pairing_codes (
  code_hash text primary key,
  username text not null references accounts(username) on delete cascade,
  device_name text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists sync_pairing_codes_expires_idx on sync_pairing_codes(expires_at);

create table if not exists sync_devices (
  id text primary key,
  token_hash text unique not null,
  username text not null references accounts(username) on delete cascade,
  device_name text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists sync_devices_username_idx on sync_devices(username);

create table if not exists password_recovery_requests (
  id text primary key,
  username text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'completed', 'denied', 'expired')),
  source text not null default 'user'
    check (source in ('user', 'admin')),
  admin_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz
);

create unique index if not exists password_recovery_one_pending_idx
  on password_recovery_requests(username) where status = 'pending';
create index if not exists password_recovery_status_created_idx
  on password_recovery_requests(status, created_at desc);
create index if not exists password_recovery_username_created_idx
  on password_recovery_requests(username, created_at desc);
