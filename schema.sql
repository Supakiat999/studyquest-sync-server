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
