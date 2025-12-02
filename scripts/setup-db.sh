#!/bin/bash

# Database Setup Script for Viral Score Collector
# This script creates the PostgreSQL database and runs migrations

set -e

echo "=================================="
echo "Viral Score Collector - DB Setup"
echo "=================================="
echo ""

# Load environment variables
if [ -f .env ]; then
    echo "✓ Loading .env file..."
    export $(cat .env | grep -v '^#' | xargs)
else
    echo "✗ .env file not found!"
    echo "Please create a .env file with DATABASE_URL"
    exit 1
fi

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "✗ DATABASE_URL environment variable is not set"
    exit 1
fi

echo "✓ DATABASE_URL is set"

# Parse database connection info
DB_NAME=$(echo $DATABASE_URL | sed -E 's/.*\/([^?]+).*/\1/')
DB_USER=$(echo $DATABASE_URL | sed -E 's/.*:\/\/([^:]+):.*/\1/')
DB_HOST=$(echo $DATABASE_URL | sed -E 's/.*@([^:\/]+).*/\1/')
DB_PORT=$(echo $DATABASE_URL | sed -E 's/.*:([0-9]+)\/.*/\1/')

echo ""
echo "Database Configuration:"
echo "  Host: $DB_HOST"
echo "  Port: $DB_PORT"
echo "  User: $DB_USER"
echo "  Database: $DB_NAME"
echo ""

# Check PostgreSQL connection
echo "→ Testing PostgreSQL connection..."
if ! psql -h $DB_HOST -p $DB_PORT -U $DB_USER -c "SELECT 1" postgres &> /dev/null; then
    echo "✗ Cannot connect to PostgreSQL"
    echo "Please ensure PostgreSQL is running and credentials are correct"
    exit 1
fi
echo "✓ PostgreSQL connection successful"

# Create database if it doesn't exist
echo ""
echo "→ Creating database '$DB_NAME' if not exists..."
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -tc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" postgres | grep -q 1 || \
    psql -h $DB_HOST -p $DB_PORT -U $DB_USER -c "CREATE DATABASE $DB_NAME" postgres
echo "✓ Database '$DB_NAME' is ready"

# Generate migrations
echo ""
echo "→ Generating database migrations..."
bun run db:generate
echo "✓ Migrations generated"

# Run migrations
echo ""
echo "→ Running database migrations..."
bun run db:migrate
echo "✓ Migrations completed"

echo ""
echo "=================================="
echo "✅ Database setup complete!"
echo "=================================="
echo ""
echo "You can now start the server with:"
echo "  bun run dev     # Development mode with hot reload"
echo "  bun run start   # Production mode"
echo ""
