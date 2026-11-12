-- Executed once when the PostgreSQL volume is first created.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE DATABASE jarvis_test OWNER jarvis;
CREATE DATABASE jarvis_e2e OWNER jarvis;
\c jarvis_test
CREATE EXTENSION IF NOT EXISTS vector;
\c jarvis_e2e
CREATE EXTENSION IF NOT EXISTS vector;
