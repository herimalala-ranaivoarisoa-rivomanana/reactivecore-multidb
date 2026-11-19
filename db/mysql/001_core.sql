CREATE TABLE IF NOT EXISTS rc_tenants (
    id CHAR(36) PRIMARY KEY
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rc_commit_clock (
    id TINYINT PRIMARY KEY CHECK (id = 1),
    last_seq BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;

INSERT INTO rc_commit_clock (id, last_seq) VALUES (1, 0)
    ON DUPLICATE KEY UPDATE last_seq = last_seq;

CREATE TABLE IF NOT EXISTS rc_receipts (
    tenant_id CHAR(36) NOT NULL,
    principal_id CHAR(36) NOT NULL,
    mutation_name VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    idempotency_key CHAR(36) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    response JSON,
    commit_seq BIGINT UNSIGNED,
    PRIMARY KEY (tenant_id, principal_id, mutation_name, idempotency_key),
    FOREIGN KEY (tenant_id) REFERENCES rc_tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rc_changes (
    seq BIGINT UNSIGNED NOT NULL,
    ordinal INT UNSIGNED NOT NULL,
    event_id CHAR(36) NOT NULL UNIQUE,
    tenant_id CHAR(36) NOT NULL,
    table_name VARCHAR(63) NOT NULL,
    document_id CHAR(36) NOT NULL,
    operation ENUM('insert', 'update', 'delete') NOT NULL,
    before_data JSON,
    after_data JSON,
    PRIMARY KEY (seq, ordinal),
    KEY tenant_seq (tenant_id, seq),
    FOREIGN KEY (tenant_id) REFERENCES rc_tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rc_outbox (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_id CHAR(36) NOT NULL UNIQUE,
    tenant_id CHAR(36) NOT NULL,
    event_type VARCHAR(63) NOT NULL,
    aggregate_id CHAR(36) NOT NULL,
    payload JSON NOT NULL,
    published_at DATETIME(6),
    lease_token CHAR(36),
    available_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    KEY pending (published_at, available_at, id),
    FOREIGN KEY (tenant_id) REFERENCES rc_tenants(id)
) ENGINE=InnoDB;
