alter table accounts add column if not exists state_manifest jsonb;
alter table accounts add column if not exists state_manifest_version integer not null default 0;

create table if not exists app_maintenance_state (
  task_name text primary key,
  last_completed_at timestamptz,
  detail jsonb not null default '{}'::jsonb
);

create table if not exists state_conflict_copies (
  id uuid primary key,
  username text not null references accounts(username) on delete cascade,
  mutation_id text not null,
  device_id text not null,
  reason text not null,
  base_revision bigint,
  base_hash text,
  cloud_revision bigint not null,
  cloud_hash text not null,
  candidate_hash text not null,
  candidate_bytes integer not null,
  candidate_gzip bytea not null,
  compressed_bytes integer not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_revision bigint,
  resolution_mutation_id text,
  retention_expires_at timestamptz not null default (now() + interval '90 days')
);

create unique index if not exists state_conflict_copies_dedupe_idx
  on state_conflict_copies(username, mutation_id, candidate_hash);
create index if not exists state_conflict_copies_user_unresolved_idx
  on state_conflict_copies(username, created_at desc) where resolved_at is null;
create index if not exists state_conflict_copies_retention_idx
  on state_conflict_copies(retention_expires_at);

alter table state_save_events add column if not exists conflict_copy_id uuid;
