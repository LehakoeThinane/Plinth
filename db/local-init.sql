-- Local bootstrap only; staging roles/credentials are provisioned separately.
CREATE ROLE plinth_app LOGIN PASSWORD 'local-development-only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE plinth_auth LOGIN PASSWORD 'local-development-only' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE plinth_auth_executor NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE plinth_identity_executor NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE plinth_consent_executor NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE plinth_branding_reader NOLOGIN NOSUPERUSER NOBYPASSRLS;
