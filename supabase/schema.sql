-- Scrumly sync: run once in your Supabase project (SQL Editor -> New query ->
-- paste all of this -> Run). Safe to run again.
--
-- One generic table rather than one per Scrumly table, so a new version of the
-- app that adds a table needs no migration here. Every row belongs to the user
-- who wrote it, and row level security means a signed-in user can only ever
-- see or change their own.

create sequence if not exists public.scrumly_rows_seq;

create table if not exists public.scrumly_rows (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  tbl        text        not null,
  id         text        not null,
  data       jsonb,                          -- null once deleted
  deleted    boolean     not null default false,
  device     text,                           -- which device wrote it last
  seq        bigint      not null default nextval('public.scrumly_rows_seq'),
  updated_at timestamptz not null default now(),
  primary key (user_id, tbl, id)
);

create index if not exists scrumly_rows_user_seq on public.scrumly_rows (user_id, seq);

-- Every write gets a fresh, increasing number. Devices ask for "everything
-- after the last number I saw", which cannot skip rows the way a timestamp can.
create or replace function public.scrumly_rows_touch() returns trigger
language plpgsql as $$
begin
  new.seq := nextval('public.scrumly_rows_seq');
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists scrumly_rows_touch on public.scrumly_rows;
create trigger scrumly_rows_touch before insert or update on public.scrumly_rows
  for each row execute function public.scrumly_rows_touch();

-- Newer projects no longer grant table access to the API roles by default.
-- Signed-in users get it here; anonymous visitors get nothing at all. The
-- sequence grant is for the trigger above, which runs as the signed-in user.
revoke all on public.scrumly_rows from anon;
grant select, insert, update, delete on public.scrumly_rows to authenticated;
grant usage, select on sequence public.scrumly_rows_seq to authenticated;

alter table public.scrumly_rows enable row level security;

drop policy if exists "own rows" on public.scrumly_rows;
create policy "own rows" on public.scrumly_rows
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Lets an open device hear about a change the moment another one saves it.
do $$
begin
  alter publication supabase_realtime add table public.scrumly_rows;
exception when duplicate_object then null;
end $$;
