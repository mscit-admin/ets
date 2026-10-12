-- ETS — create the PostgreSQL role and database.
-- Run as the postgres superuser:
--   sudo -u postgres psql -v ets_password="'CHANGE-ME'" -f deploy/db/create-database.sql
-- (deploy/install.sh does this automatically with a generated password.)
-- The tables themselves are created by the application migrations
-- (backend/src/db/migrations/*.sql) on first start, or with `npm run setup`.

CREATE ROLE ets LOGIN PASSWORD :ets_password;
CREATE DATABASE ets OWNER ets ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0;
\connect ets
CREATE EXTENSION IF NOT EXISTS citext;
ALTER SCHEMA public OWNER TO ets;
