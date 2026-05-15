create table if not exists accounts (
  username text primary key,
  display_name text not null,
  password_record jsonb not null,
  state jsonb,
  state_bytes integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sessions (
  token_hash text primary key,
  username text not null references accounts(username) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);

create index if not exists sessions_username_idx on sessions(username);
create index if not exists sessions_expires_at_idx on sessions(expires_at);
