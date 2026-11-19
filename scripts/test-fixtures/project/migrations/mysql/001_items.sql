CREATE TABLE IF NOT EXISTS items (
    id CHAR(36) PRIMARY KEY,
    tenant_id CHAR(36) NOT NULL,
    title VARCHAR(120) NOT NULL CHECK (CHAR_LENGTH(title) BETWEEN 1 AND 120),
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    KEY items_tenant_created (tenant_id, created_at DESC, id),
    FOREIGN KEY (tenant_id) REFERENCES rc_tenants(id)
) ENGINE=InnoDB;
