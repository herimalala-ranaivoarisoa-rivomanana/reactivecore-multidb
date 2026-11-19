CREATE TABLE IF NOT EXISTS rc_tenant_clocks (
    tenant_id CHAR(36) PRIMARY KEY,
    last_seq BIGINT UNSIGNED NOT NULL,
    pruned_through BIGINT UNSIGNED NOT NULL DEFAULT 0,
    CHECK (pruned_through <= last_seq),
    FOREIGN KEY (tenant_id) REFERENCES rc_tenants(id)
) ENGINE=InnoDB;

INSERT INTO rc_tenant_clocks (tenant_id, last_seq)
SELECT tenant.id, clock.last_seq
FROM rc_tenants AS tenant CROSS JOIN rc_commit_clock AS clock
WHERE NOT EXISTS (SELECT 1 FROM rc_tenant_clocks AS existing WHERE existing.tenant_id = tenant.id);

ALTER TABLE rc_changes DROP PRIMARY KEY, ADD PRIMARY KEY (tenant_id, seq, ordinal);
