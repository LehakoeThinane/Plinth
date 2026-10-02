-- Local bootstrap only; staging roles/credentials are provisioned separately.
CREATE ROLE plinth_app LOGIN PASSWORD 'local-development-only' NOSUPERUSER NOBYPASSRLS;
