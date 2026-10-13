#!/bin/bash

echo "=== BlockFarming Infrastructure Starting ==="

mkdir -p /var/lib/postgresql/data
mkdir -p /var/run/postgresql
chown -R postgres:postgres /var/lib/postgresql
chown -R postgres:postgres /var/run/postgresql
chmod 777 /var/run/postgresql

if [ ! -d "/var/lib/postgresql/data/base" ]; then
  echo "[1/5] Initializing PostgreSQL data directory..."
  su-exec postgres initdb -D /var/lib/postgresql/data
  echo "[1/5] PostgreSQL initialized."
else
  echo "[1/5] PostgreSQL data directory already exists."
fi

# pg_hba.conf
echo "[FIX] Configuring pg_hba.conf..."
cat > /var/lib/postgresql/data/pg_hba.conf << 'HBA'
local   all             all                                     trust
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
host    all             all             172.16.0.0/12           trust
host    all             all             10.0.0.0/8              trust
host    all             all             192.168.0.0/16          trust
host    all             all             0.0.0.0/0               md5
host    all             all             ::/0                    md5
HBA
chown postgres:postgres /var/lib/postgresql/data/pg_hba.conf

grep -q "^listen_addresses" /var/lib/postgresql/data/postgresql.conf || \
  echo "listen_addresses = '*'" >> /var/lib/postgresql/data/postgresql.conf

echo "[2/5] Starting PostgreSQL..."
su-exec postgres pg_ctl -D /var/lib/postgresql/data \
  -l /var/lib/postgresql/data/postgresql.log \
  start

echo "[3/5] Waiting for PostgreSQL to be ready..."
for i in $(seq 1 30); do
  if su-exec postgres pg_isready -q; then
    echo "[3/5] PostgreSQL is ready."
    break
  fi
  echo "   Waiting... ($i/30)"
  sleep 1
done

echo "[4/5] Creating user and database..."
su-exec postgres psql -c "CREATE USER blockfarming WITH PASSWORD 'blockfarming';" 2>/dev/null || echo "   User already exists."
su-exec postgres psql -c "ALTER USER blockfarming WITH PASSWORD 'blockfarming';" 2>/dev/null || true
su-exec postgres psql -c "CREATE DATABASE blockfarming OWNER blockfarming;" 2>/dev/null || echo "   Database already exists."

echo "[4/5] Loading schema and seed data as blockfarming user..."
su-exec postgres psql -U blockfarming -d blockfarming -f /init.sql 2>&1 | grep -v "already exists" || true

echo "[4/5] Verifying tables..."
su-exec postgres psql -U blockfarming -d blockfarming -c "\dt"

# ============================================
# REDIS: Explicit config to bind all interfaces
# ============================================
echo "[5/5] Starting Redis..."

cat > /etc/redis.conf << 'REDISCONF'
bind 0.0.0.0
port 6379
protected-mode no
daemonize no
save 900 1
save 300 10
save 60 10000
appendonly no
REDISCONF

redis-server /etc/redis.conf &
REDIS_PID=$!

# Verify Redis is listening
sleep 2
if redis-cli -h 127.0.0.1 ping | grep -q PONG; then
  echo "Redis: ready and listening on 0.0.0.0:6379"
else
  echo "Redis: FAILED to start"
fi

echo "=== Infrastructure Ready ==="
echo "PostgreSQL: 0.0.0.0:5432"
echo "Redis: 0.0.0.0:6379"

wait $REDIS_PID
