CREATE TABLE IF NOT EXISTS batches (
    id SERIAL PRIMARY KEY,
    batch_id VARCHAR(64) UNIQUE NOT NULL,
    product_name VARCHAR(255) NOT NULL,
    manufacturer VARCHAR(255) NOT NULL,
    manufacture_date DATE NOT NULL,
    expiry_date DATE NOT NULL,
    chemical_composition TEXT,
    quantity INT NOT NULL,
    blockchain_hash VARCHAR(128) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tokens (
    id SERIAL PRIMARY KEY,
    token_code VARCHAR(32) UNIQUE NOT NULL,
    batch_id VARCHAR(64) REFERENCES batches(batch_id),
    status VARCHAR(20) DEFAULT 'UNREDEEMED',
    redeemed_at TIMESTAMP,
    redeemed_by VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    fis_linked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fis_tokens (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    token_code VARCHAR(16) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS custody_logs (
    id SERIAL PRIMARY KEY,
    batch_id VARCHAR(64) REFERENCES batches(batch_id),
    distributor_id VARCHAR(64),
    dealer_id VARCHAR(64),
    action VARCHAR(50),
    gps_latitude DECIMAL(10, 8),
    gps_longitude DECIMAL(11, 8),
    scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    transaction_ref VARCHAR(64) UNIQUE NOT NULL,
    token_code VARCHAR(32) REFERENCES tokens(token_code),
    dealer_phone VARCHAR(20) NOT NULL,
    amount DECIMAL(12, 2) NOT NULL,
    mno_provider VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ussd_sessions (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(64) UNIQUE NOT NULL,
    phone_number VARCHAR(20) NOT NULL,
    token_code VARCHAR(32),
    response TEXT,
    cell_id VARCHAR(64),
    session_status VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);
CREATE INDEX IF NOT EXISTS idx_tokens_batch ON tokens(batch_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_ussd_phone ON ussd_sessions(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_fis_tokens_email ON fis_tokens(email);

INSERT INTO batches (batch_id, product_name, manufacturer, manufacture_date, expiry_date, chemical_composition, quantity, blockchain_hash)
VALUES 
('BATCH-2024-001', 'NPK 20-10-10', 'Minjingu Mines', '2024-01-15', '2026-01-15', 'N:20%, P:10%, K:10%', 1000, 'a1b2c3d4e5f6'),
('BATCH-2024-002', 'UREA 46%', 'YARA Tanzania', '2024-02-01', '2026-02-01', 'N:46%', 2000, 'f6e5d4c3b2a1')
ON CONFLICT (batch_id) DO NOTHING;

INSERT INTO tokens (token_code, batch_id, status)
VALUES 
('A1B2C3', 'BATCH-2024-001', 'UNREDEEMED'),
('D4E5F6', 'BATCH-2024-001', 'UNREDEEMED'),
('G7H8I9', 'BATCH-2024-002', 'UNREDEEMED')
ON CONFLICT (token_code) DO NOTHING;