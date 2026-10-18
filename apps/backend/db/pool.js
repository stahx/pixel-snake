import pg from 'pg';

export const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 })
  : null;

pool?.on('error', (error) => console.error('PostgreSQL pool error:', error.message));
