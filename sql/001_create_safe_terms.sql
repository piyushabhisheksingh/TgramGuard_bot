-- Safe terms table used by src/filters/customTerms.js
-- Conflict target in code: onConflict: 'term'
-- This migration creates a simple table with a unique key on term

begin;

create table if not exists public.safe_terms (
  term text primary key,
  created_at timestamptz not null default now()
);

comment on table public.safe_terms is 'False-positive safelist terms for explicit-content filter';
comment on column public.safe_terms.term is 'Original text for the safe term; unique and used for upserts';
comment on column public.safe_terms.created_at is 'Insertion timestamp';

-- Optional: if you prefer a surrogate key, uncomment below and drop PK on term.
-- alter table public.safe_terms add column if not exists id bigserial;
-- alter table public.safe_terms drop constraint if exists safe_terms_pkey;
-- alter table public.safe_terms add primary key (id);
-- create unique index if not exists safe_terms_term_key on public.safe_terms(term);

commit;

