// test-db.js
const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'horse_racing',
    password: 'mahtot123',
    port: 5432,
});

async function test() {
    try {
        console.log('1. Testing connection...');
        const conn = await pool.connect();
        console.log('✅ Connected to database');
        
        console.log('2. Checking users table...');
        const users = await conn.query('SELECT COUNT(*) FROM users');
        console.log(`✅ Current users: ${users.rows[0].count}`);
        
        console.log('3. Attempting to insert test user...');
        const testPhone = `TEST_${Date.now()}`;
        const insert = await conn.query(
            'INSERT INTO users (phone, password, wallet_balance) VALUES ($1, $2, $3) RETURNING *',
            [testPhone, 'test123', 100.00]
        );
        console.log('✅ Insert successful:', insert.rows[0]);
        
        console.log('4. Verifying insert...');
        const verify = await conn.query('SELECT * FROM users WHERE phone = $1', [testPhone]);
        console.log('✅ User found:', verify.rows[0]);
        
        conn.release();
        pool.end();
        
    } catch (err) {
        console.error('❌ Error:', err);
    }
}

test();