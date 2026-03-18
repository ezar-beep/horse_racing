// telegram-bot.js
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');

// Load environment variables if .env exists
try {
    require('dotenv').config();
} catch (err) {
    console.log('⚠️ dotenv not installed, using default values');
}

// Database connection (reuse your existing config)
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'horse_racing',
    password: 'mahtot123',
    port: 5432,
});

// Bot token - replace with your actual token
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';

if (BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.log('⚠️ Please set your BOT_TOKEN in .env file or replace it in the code');
    process.exit(1);
}

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// Store registration sessions
const sessions = new Map();

// Phone validation
const isValidPhone = (phone) => /^[\+]?[(]?[0-9]{1,3}[)]?[-\s\.]?[0-9]{1,4}[-\s\.]?[0-9]{1,4}[-\s\.]?[0-9]{1,9}$/.test(phone);
const cleanPhone = (phone) => phone.replace(/[\s\-\(\)]/g, '');

// Create telegram users table
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS telegram_users (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT UNIQUE NOT NULL,
                username VARCHAR(100),
                phone VARCHAR(20) UNIQUE,
                registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Telegram users table ready');
    } catch (err) {
        console.error('❌ Failed to create table:', err.message);
    }
}

// /start command
bot.start((ctx) => {
    ctx.reply(
        '🐎 Welcome to Horse Racing Bet Bot!\n\n' +
        'Commands:\n' +
        '/register - Register with username and phone\n' +
        '/balance - Check your wallet balance\n' +
        '/help - Show this menu'
    );
});

// /help command
bot.help((ctx) => {
    ctx.reply(
        'Available commands:\n' +
        '/register - Register new account\n' +
        '/balance - Check wallet balance\n' +
        '/cancel - Cancel registration'
    );
});

// /cancel command
bot.command('cancel', (ctx) => {
    if (sessions.delete(ctx.from.id)) {
        ctx.reply('❌ Registration cancelled');
    } else {
        ctx.reply('No active session');
    }
});

// /register command
bot.command('register', async (ctx) => {
    const userId = ctx.from.id;
    
    try {
        // Check if already registered
        const existing = await pool.query(
            'SELECT * FROM telegram_users WHERE telegram_id = $1',
            [userId]
        );
        
        if (existing.rows.length > 0) {
            return ctx.reply(
                `✅ Already registered!\nUsername: ${existing.rows[0].username}\nPhone: ${existing.rows[0].phone}`
            );
        }
        
        sessions.set(userId, { step: 'username', telegram_id: userId });
        ctx.reply('📝 Enter your username:', 
            Markup.inlineKeyboard([Markup.button.callback('Cancel', 'cancel')])
        );
    } catch (err) {
        console.error('Register error:', err);
        ctx.reply('❌ Database error. Try again later.');
    }
});

// Handle text messages
bot.on('text', async (ctx) => {
    const session = sessions.get(ctx.from.id);
    if (!session || ctx.message.text.startsWith('/')) return;
    
    try {
        if (session.step === 'username') {
            if (ctx.message.text.length < 3) {
                return ctx.reply('❌ Username too short. Min 3 characters:');
            }
            
            const check = await pool.query(
                'SELECT * FROM telegram_users WHERE username = $1',
                [ctx.message.text]
            );
            
            if (check.rows.length > 0) {
                return ctx.reply('❌ Username taken. Try another:');
            }
            
            session.username = ctx.message.text;
            session.step = 'phone';
            ctx.reply('📞 Enter your phone number (e.g., +1234567890):');
            
        } else if (session.step === 'phone') {
            if (!isValidPhone(ctx.message.text)) {
                return ctx.reply('❌ Invalid phone format. Try again (e.g., +1234567890):');
            }
            
            const phone = cleanPhone(ctx.message.text);
            const check = await pool.query(
                'SELECT * FROM telegram_users WHERE phone = $1',
                [phone]
            );
            
            if (check.rows.length > 0) {
                return ctx.reply('❌ Phone already registered.');
            }
            
            session.phone = phone;
            ctx.reply(
                `Confirm your details:\n\nUsername: ${session.username}\nPhone: ${session.phone}`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Yes', 'confirm'), 
                     Markup.button.callback('❌ No', 'cancel')]
                ])
            );
            session.step = 'confirm';
        }
    } catch (err) {
        console.error('Registration error:', err);
        ctx.reply('❌ Error occurred. Try /register again');
        sessions.delete(ctx.from.id);
    }
});

// Handle confirm button
bot.action('confirm', async (ctx) => {
    const session = sessions.get(ctx.from.id);
    if (!session) {
        return ctx.editMessageText('❌ Session expired. Use /register');
    }
    
    try {
        await pool.query(
            'INSERT INTO telegram_users (telegram_id, username, phone) VALUES ($1, $2, $3)',
            [session.telegram_id, session.username, session.phone]
        );
        
        await ctx.editMessageText('✅ Registration successful! You can now use /balance');
        sessions.delete(ctx.from.id);
        
    } catch (err) {
        console.error('DB insert error:', err);
        ctx.editMessageText('❌ Registration failed');
    }
});

// Handle cancel button
bot.action('cancel', (ctx) => {
    sessions.delete(ctx.from.id);
    ctx.editMessageText('❌ Cancelled');
});

// /balance command - check wallet from main app
bot.command('balance', async (ctx) => {
    try {
        const result = await pool.query(
            `SELECT u.phone, u.wallet_balance 
             FROM users u 
             JOIN telegram_users t ON u.phone = t.phone 
             WHERE t.telegram_id = $1`,
            [ctx.from.id]
        );
        
        if (result.rows.length === 0) {
            return ctx.reply('❌ Not registered or phone not linked. Use /register first');
        }
        
        ctx.reply(`💰 Your balance: $${parseFloat(result.rows[0].wallet_balance).toFixed(2)}`);
        
    } catch (err) {
        console.error('Balance error:', err);
        ctx.reply('❌ Error fetching balance');
    }
});

// Error handler
bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    ctx.reply('An error occurred. Please try again.');
});

// Start bot
async function startBot() {
    await initDB();
    bot.launch();
    console.log('🤖 Telegram bot running...');
}

startBot();

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));