-- ETS — create the PostgreSQL role and database (names are chosen at install time).
-- Run as the postgres superuser, then give the role its password interactively (never on the
-- command line, where it would show in the process list and the shell history):
--   sudo -u postgres psql -v ON_ERROR_STOP=1 -v db_name=ets -v db_user=ets -f deploy/db/create-database.sql
--   sudo -u postgres psql -c '\password ets'
-- deploy/install.sh runs this for you and sets the password as a SCRAM verifier (deploy/db/scram-verifier.mjs).
-- The tables are created afterwards by the application migrations
-- (backend/src/db/migrations/*.sql) — `npm run setup` or on first start.

CREATE ROLE :"db_user" LOGIN;
CREATE DATABASE :"db_name" OWNER :"db_user" ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0;
-- only the application role may connect; nobody else may create objects in its schema
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db_name" TO :"db_user";
\connect :"db_name"
CREATE EXTENSION IF NOT EXISTS citext;
ALTER SCHEMA public OWNER TO :"db_user";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
