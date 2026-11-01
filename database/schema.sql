create table public.collections (
  id uuid not null default gen_random_uuid (),
  userid uuid not null,
  name text not null,
  description text null,
  authtype text not null default 'none'::text,
  authconfig jsonb not null default '{}'::jsonb,
  headers jsonb not null default '[]'::jsonb,
  variables jsonb not null default '[]'::jsonb,
  created timestamp with time zone not null default now(),
  updated timestamp with time zone not null default now(),
  settings jsonb not null default '{}'::jsonb,
  constraint collections_pkey primary key (id),
  constraint collections_userid_name_key unique (userid, name),
  constraint collections_userid_fkey foreign KEY (userid) references auth.users (id) on delete CASCADE,
  constraint collections_authtype_check check (
    (
      authtype = any (
        array[
          'none'::text,
          'bearer'::text,
          'basic'::text,
          'apikey'::text
        ]
      )
    )
  ),
  constraint collections_limits check (
    (
      (COALESCE(char_length(description), 0) <= 200)
      and (pg_column_size(headers) <= 100000)
      and (pg_column_size(variables) <= 100000)
      and (pg_column_size(authconfig) <= 20000)
      and (pg_column_size(settings) <= 20000)
    )
  ) not VALID,
  constraint collections_name_check check (
    (
      (length(name) >= 1)
      and (length(name) <= 30)
    )
  )
) TABLESPACE pg_default;

create index IF not exists collections_userid_idx on public.collections using btree (userid) TABLESPACE pg_default;

create trigger trg_quota BEFORE INSERT on collections for EACH row
execute FUNCTION enforce_quota ('100');

create trigger trg_set_updated BEFORE
update on collections for EACH row
execute FUNCTION set_updated ();

create table public.logs (
  id uuid not null default gen_random_uuid (),
  userid uuid null,
  endpoint text not null,
  statuscode integer not null,
  message text not null,
  created timestamp with time zone not null default timezone ('utc'::text, now()),
  constraint logs_pkey primary key (id),
  constraint logs_userid_fkey foreign KEY (userid) references auth.users (id) on delete CASCADE,
  constraint logs_limits check (
    (
      (char_length(endpoint) <= 2000)
      and (COALESCE(char_length(message), 0) <= 1000)
    )
  ) not VALID
) TABLESPACE pg_default;

create index IF not exists logs_userid_idx on public.logs using btree (userid) TABLESPACE pg_default;

create index IF not exists logs_created_idx on public.logs using btree (created) TABLESPACE pg_default;

create table public.requests (
  id uuid not null default gen_random_uuid (),
  userid uuid not null,
  folderid uuid null,
  name text not null,
  method text not null default 'GET'::text,
  url text not null,
  params jsonb not null default '[]'::jsonb,
  headers jsonb not null default '[]'::jsonb,
  bodytype text not null default 'none'::text,
  body text null,
  created timestamp with time zone not null default now(),
  updated timestamp with time zone not null default now(),
  collectionid uuid null,
  constraint requests_pkey primary key (id),
  constraint requests_folderid_fkey foreign KEY (folderid) references apifolders (id) on delete CASCADE,
  constraint requests_collectionid_fkey foreign KEY (collectionid) references collections (id) on delete CASCADE,
  constraint requests_userid_fkey foreign KEY (userid) references auth.users (id) on delete CASCADE,
  constraint requests_method_check check (
    (
      method = any (
        array[
          'GET'::text,
          'POST'::text,
          'PATCH'::text,
          'DELETE'::text,
          'PUT'::text,
          'HEAD'::text,
          'OPTIONS'::text
        ]
      )
    )
  ),
  constraint requests_limits check (
    (
      (char_length(url) <= 2000)
      and (COALESCE(char_length(body), 0) <= 200000)
      and (pg_column_size(params) <= 100000)
      and (pg_column_size(headers) <= 100000)
    )
  ) not VALID,
  constraint requests_bodytype_check check (
    (
      bodytype = any (
        array[
          'none'::text,
          'json'::text,
          'form-data'::text,
          'urlencoded'::text,
          'raw'::text,
          'graphql'::text
        ]
      )
    )
  ),
  constraint requests_name_check check (
    (
      (length(name) >= 1)
      and (length(name) <= 30)
    )
  )
) TABLESPACE pg_default;

create index IF not exists requests_userid_idx on public.requests using btree (userid) TABLESPACE pg_default;

create index IF not exists requests_folderid_idx on public.requests using btree (folderid) TABLESPACE pg_default;

create index IF not exists requests_collectionid_idx on public.requests using btree (collectionid) TABLESPACE pg_default;

create index IF not exists requests_collection_idx on public.requests using btree (collectionid) TABLESPACE pg_default;

create trigger trg_quota BEFORE INSERT on requests for EACH row
execute FUNCTION enforce_quota ('2000');

create trigger trg_set_updated BEFORE
update on requests for EACH row
execute FUNCTION set_updated ();

create table public.apifolders (
  id uuid not null default gen_random_uuid (),
  userid uuid not null,
  name text not null,
  created timestamp with time zone not null default now(),
  constraint apifolders_pkey primary key (id),
  constraint apifolders_userid_name_key unique (userid, name),
  constraint apifolders_userid_fkey foreign KEY (userid) references auth.users (id) on delete CASCADE,
  constraint apifolders_name_check check (
    (
      (length(name) >= 1)
      and (length(name) <= 30)
    )
  )
) TABLESPACE pg_default;

create index IF not exists apifolders_userid_idx on public.apifolders using btree (userid) TABLESPACE pg_default;

create trigger trg_quota BEFORE INSERT on apifolders for EACH row
execute FUNCTION enforce_quota ('100');