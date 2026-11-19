-- These guards allow a retry after a partially applied MySQL migration.
SET @rc_retention_ddl = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE rc_receipts ADD COLUMN created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), ADD COLUMN response_expired BOOLEAN NOT NULL DEFAULT false, ADD KEY receipt_retention_candidates (tenant_id, response_expired, created_at)',
        'SELECT 1')
    FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'rc_receipts' AND column_name = 'response_expired'
);
PREPARE rc_retention_ddl FROM @rc_retention_ddl;
EXECUTE rc_retention_ddl;
DEALLOCATE PREPARE rc_retention_ddl;
