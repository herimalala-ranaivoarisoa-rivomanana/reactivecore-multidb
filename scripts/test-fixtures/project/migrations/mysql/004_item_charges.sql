ALTER TABLE items ADD UNIQUE KEY items_tenant_id (tenant_id, id);

CREATE TABLE IF NOT EXISTS charges (
    id CHAR(36) PRIMARY KEY,
    tenant_id CHAR(36) NOT NULL,
    item_id CHAR(36) NOT NULL,
    period CHAR(7) NOT NULL,
    amount_cents INT NOT NULL CHECK (amount_cents > 0),
    KEY charges_tenant_period_item (tenant_id, period, item_id),
    FOREIGN KEY (tenant_id) REFERENCES rc_tenants(id),
    FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
) ENGINE=InnoDB;
