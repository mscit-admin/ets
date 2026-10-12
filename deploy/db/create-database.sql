-- ETS — create the PostgreSQL role and database (names and password are chosen at install time).
-- Run as the postgres superuser:
--   sudo -u postgres psql -v ON_ERROR_STOP=1 \
--        -v db_name=ets -v db_user=ets -v db_password='CHANGE-ME' \
--        -f deploy/db/create-database.sql
-- deploy/install.sh runs this for you with the answers you give it.
-- The tables are created afterwards by the application migrations
-- (backend/src/db/migrations/*.sql) — `npm run setup` or on first start.

CREATE ROLE :"db_user" LOGIN PASSWORD :'db_password';
CREATE DATABASE :"db_name" OWNER :"db_user" ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0;
\connect :"db_name"
CREATE EXTENSION IF NOT EXISTS citext;
ALTER SCHEMA public OWNER TO :"db_user";
