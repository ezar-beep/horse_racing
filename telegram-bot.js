// telegram-bot.js - COMPLETE VERSION WITH REFERRAL RECORDING
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
require('dotenv').config();

// Database connection
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'horse_racing',
    password: 'mahtot123',
    port: 5432,
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
    } else {
        console.log('✅ Database connected successfully');
        release();
    }
});

// Bot token
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
    console.log('❌ Please set your BOT_TOKEN in .env file');
    process.exit(1);
}

// Your localtunnel URL
const BASE_URL = 'https://horseracing.loca.lt';

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// Store registration sessions
const sessions = new Map();

console.log('🤖 Bot starting...');
console.log('📡 Base URL:', BASE_URL);

// Phone validation
const isValidPhone = (phone) => /^[\+]?[(]?[0-9]{1,3}[)]?[-\s\.]?[0-9]{1,4}[-\s\.]?[0-9]{1,4}[-\s\.]?[0-9]{1,9}$/.test(phone);
const cleanPhone = (phone) => phone.replace(/[\s\-\(\)]/g, '');

// Generate unique referral code
function generateReferralCode(userId, phone) {
    const cleanPhone = phone.replace(/\D/g, '').slice(-4);
    return `REF${userId}${cleanPhone}`;
}

// Get referral statistics
async function getReferralStats(phone) {
    try {
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total_referrals,
                COALESCE(SUM(bonus_amount), 0) as total_bonus
            FROM referrals 
            WHERE referrer_phone = $1 AND bonus_awarded = TRUE
        `, [phone]);
        
        return result.rows[0];
    } catch (err) {
        console.error('Error getting referral stats:', err);
        return { total_referrals: 0, total_bonus: 0 };
    }
}

// Check if user is registered
async function isUserRegistered(telegramId) {
    try {
        const linkCheck = await pool.query(
            'SELECT * FROM telegram_links WHERE telegram_id = $1',
            [telegramId]
        );
        
        if (linkCheck.rows.length > 0) {
            const userCheck = await pool.query(
                'SELECT * FROM users WHERE phone = $1',
                [linkCheck.rows[0].phone]
            );
            if (userCheck.rows.length > 0) {
                return { 
                    registered: true, 
                    user: userCheck.rows[0], 
                    phone: linkCheck.rows[0].phone 
                };
            }
        }
    } catch (err) {
        console.error('Error checking registration:', err);
    }
    return { registered: false };
}

// /start command
bot.start(async (ctx) => {
    const messageText = ctx.message.text;
    let referralCode = null;
    
    const parts = messageText.split(' ');
    if (parts.length > 1) {
        referralCode = parts[1];
        console.log('🔗 Referral code detected:', referralCode);
        
        sessions.set(ctx.from.id, { 
            referral_code: referralCode,
            step: 'start'
        });
    }
    
    ctx.reply(
        '🐎 Horse Racing Bet Bot\n\n' +
        'Commands:\n' +
        '/register - Create new account\n' +
        '/play - Auto-login to app\n' +
        '/balance - Check wallet balance\n' +
        '/invite - Get your referral link\n' +
        '/referrals - View your referrals\n' +
        '/help - Show this menu'
    );
});

// /help command
bot.help((ctx) => {
    ctx.reply(
        'Available commands:\n' +
        '/register - Register new account\n' +
        '/play - Auto-login to app\n' +
        '/balance - Check your balance\n' +
        '/invite - Get your referral link\n' +
        '/referrals - View your referrals\n' +
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

// /invite command
bot.command('invite', async (ctx) => {
    try {
        const registered = await isUserRegistered(ctx.from.id);
        
        if (!registered.registered) {
            return ctx.reply('❌ You need to register first. Use /register');
        }
        
        const botUsername = ctx.botInfo ? ctx.botInfo.username : 'horseracing_bot';
        
        const userData = await pool.query(
            'SELECT referral_code FROM users WHERE phone = $1',
            [registered.phone]
        );
        
        const referralCode = userData.rows[0].referral_code;
        const inviteLink = `https://t.me/${botUsername}?start=${referralCode}`;
        
        const awarded = await pool.query(
            'SELECT COUNT(*) as count FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = TRUE',
            [registered.phone]
        );
        
        const pending = await pool.query(
            'SELECT COUNT(*) as count FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = FALSE',
            [registered.phone]
        );
        
        const bonus = await pool.query(
            'SELECT COALESCE(SUM(bonus_amount), 0) as total FROM referrals WHERE referrer_phone = $1 AND bonus_awarded = TRUE',
            [registered.phone]
        );
        
        await ctx.reply(
            `👥 Your Referral Program\n\n` +
            `Share this link:\n${inviteLink}\n\n` +
            `Statistics:\n` +
            `• Awarded Referrals: ${awarded.rows[0].count}\n` +
            `• Pending Referrals: ${pending.rows[0].count}\n` +
            `• Total Bonus Earned: $${parseFloat(bonus.rows[0].total).toFixed(2)}\n\n` +
            `You get $10 for each friend who makes their first deposit!`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '👥 View Details', callback_data: 'view_referrals' }]
                    ]
                }
            }
        );
        
    } catch (err) {
        console.error('Invite error:', err);
        ctx.reply('❌ Error. Please try again.');
    }
});

// /referrals command
bot.command('referrals', async (ctx) => {
    await viewReferrals(ctx);
});

bot.action('view_referrals', async (ctx) => {
    await viewReferrals(ctx);
});

async function viewReferrals(ctx) {
    try {
        const registered = await isUserRegistered(ctx.from.id);
        
        if (!registered.registered) {
            return ctx.reply('❌ You need to register first. Use /register');
        }
        
        const awarded = await pool.query(`
            SELECT referred_phone, created_at, bonus_amount, bonus_awarded_at 
            FROM referrals 
            WHERE referrer_phone = $1 AND bonus_awarded = TRUE
            ORDER BY bonus_awarded_at DESC
        `, [registered.phone]);
        
        const pending = await pool.query(`
            SELECT referred_phone, created_at 
            FROM referrals 
            WHERE referrer_phone = $1 AND bonus_awarded = FALSE
            ORDER BY created_at DESC
        `, [registered.phone]);
        
        let message = `👥 Your Referrals\n\n`;
        
        message += `✅ Awarded (${awarded.rows.length}):\n`;
        if (awarded.rows.length > 0) {
            awarded.rows.forEach((ref, i) => {
                const date = new Date(ref.bonus_awarded_at).toLocaleDateString();
                message += `  ${i+1}. ${ref.referred_phone} - $${ref.bonus_amount} (${date})\n`;
            });
        } else {
            message += `  None yet\n`;
        }
        
        message += `\n⏳ Pending (${pending.rows.length}):\n`;
        if (pending.rows.length > 0) {
            pending.rows.forEach((ref, i) => {
                const date = new Date(ref.created_at).toLocaleDateString();
                message += `  ${i+1}. ${ref.referred_phone} (registered ${date})\n`;
            });
            message += `\nPending referrals will award $10 when they make their first deposit!`;
        } else {
            message += `  None\n`;
        }
        
        await ctx.reply(message);
        
    } catch (err) {
        console.error('View referrals error:', err);
        ctx.reply('❌ Error loading referrals');
    }
}

// /register command
bot.command('register', async (ctx) => {
    const userId = ctx.from.id;
    
    let referralCode = null;
    const existingSession = sessions.get(userId);
    if (existingSession && existingSession.referral_code) {
        referralCode = existingSession.referral_code;
    }
    
    const messageText = ctx.message.text;
    const parts = messageText.split(' ');
    if (parts.length > 1) {
        referralCode = parts[1].trim();
    }
    
    try {
        const registered = await isUserRegistered(userId);
        
        if (registered.registered) {
            const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
            
            return ctx.reply(
                `✅ You are already registered!\n\n` +
                `Phone: ${registered.phone}\n` +
                `Balance: $${parseFloat(registered.user.wallet_balance).toFixed(2)}\n\n` +
                `Click below to auto-login:`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🚀 Auto-Login', web_app: { url: autoLoginUrl } }]
                        ]
                    }
                }
            );
        }
        
        sessions.set(userId, { 
            step: 'phone', 
            telegram_id: userId,
            telegram_username: ctx.from.username || 'telegram_user',
            referral_code: referralCode
        });
        
        await ctx.reply(
            '📱 Welcome!\n\n' +
            'To register, please share your phone number using the button below.\n\n' +
            'This will only be used for your account.',
            {
                reply_markup: {
                    keyboard: [
                        [{ text: '📱 Share Phone Number', request_contact: true }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            }
        );
        
    } catch (err) {
        console.error('Register error:', err);
        ctx.reply('❌ Database error. Try again later.');
    }
});

// Handle shared contact
bot.on('contact', async (ctx) => {
    const session = sessions.get(ctx.from.id);
    const userId = ctx.from.id;
    const contact = ctx.message.contact;
    
    if (contact.user_id !== userId) {
        return ctx.reply('❌ Please share your own phone number.');
    }
    
    const phone = contact.phone_number;
    const telegramUsername = ctx.from.username || 'telegram_user';
    
    try {
        const registered = await isUserRegistered(userId);
        
        if (registered.registered) {
            await ctx.reply('✅ You are already registered!', {
                reply_markup: { remove_keyboard: true }
            });
            
            const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
            
            return ctx.reply(
                `Click below to auto-login:`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🚀 Auto-Login', web_app: { url: autoLoginUrl } }]
                        ]
                    }
                }
            );
        }
        
        const check = await pool.query(
            'SELECT * FROM users WHERE phone = $1',
            [phone]
        );
        
        if (check.rows.length > 0) {
            await pool.query(
                'INSERT INTO telegram_links (telegram_id, telegram_username, phone) VALUES ($1, $2, $3)',
                [userId, telegramUsername, phone]
            );
            
            await ctx.reply('✅ Phone number linked to your existing account!', {
                reply_markup: { remove_keyboard: true }
            });
            
            const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(phone)}&auto=1`;
            
            return ctx.reply(
                `Click below to auto-login:`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🚀 Auto-Login', web_app: { url: autoLoginUrl } }]
                        ]
                    }
                }
            );
        }
        
        const userReferralCode = generateReferralCode(userId, phone);
        
        const userInsert = await pool.query(
            'INSERT INTO users (phone, password, wallet_balance, referral_code) VALUES ($1, $2, $3, $4) RETURNING *',
            [phone, 'telegram123', 100.00, userReferralCode]
        );
        
        console.log('✅ New user created:', userInsert.rows[0]);
        
        await pool.query(
            'INSERT INTO telegram_links (telegram_id, telegram_username, phone) VALUES ($1, $2, $3)',
            [userId, telegramUsername, phone]
        );
        
        // RECORD REFERRAL IF PROVIDED (BUT DON'T AWARD BONUS YET)
        if (session && session.referral_code) {
            console.log('🔗 Referral code provided:', session.referral_code);
            
            const referrer = await pool.query(
                'SELECT phone FROM users WHERE referral_code = $1',
                [session.referral_code]
            );
            
            if (referrer.rows.length > 0) {
                const referrerPhone = referrer.rows[0].phone;
                
                // Record referral with bonus_awarded = FALSE
                await pool.query(
                    'INSERT INTO referrals (referrer_phone, referred_phone, bonus_amount, bonus_awarded) VALUES ($1, $2, $3, $4)',
                    [referrerPhone, phone, 10.00, false]
                );
                
                console.log(`🔗 Referral recorded: ${referrerPhone} referred ${phone} (bonus pending first deposit)`);
            }
        }
        
        await ctx.reply('✅ Registration successful!', {
            reply_markup: { remove_keyboard: true }
        });
        
        const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(phone)}&auto=1`;
        
        await ctx.reply(
            `Your account is ready!\n\n` +
            `Phone: ${phone}\n` +
            `Balance: $100.00\n\n` +
            `Your Referral Code: ${userReferralCode}\n\n` +
            `Share your code with friends! You get $10 when they make their first deposit.\n\n` +
            `Click below to start playing:`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🚀 Start Playing', web_app: { url: autoLoginUrl } }],
                        [{ text: '👥 My Referrals', callback_data: 'view_referrals' }]
                    ]
                }
            }
        );
        
        sessions.delete(ctx.from.id);
        
    } catch (err) {
        console.error('Contact handler error:', err);
        ctx.reply('❌ Registration failed. Please try again.', {
            reply_markup: { remove_keyboard: true }
        });
    }
});

bot.command('play', async (ctx) => {
    const userId = ctx.from.id;
    
    try {
        const registered = await isUserRegistered(userId);
        
        if (registered.registered) {
            const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
            
            return ctx.reply(
                `Click below to auto-login:`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🚀 Play', web_app: { url: autoLoginUrl } }]
                        ]
                    }
                }
            );
        }
        
        ctx.reply('❌ Not registered. Use /register first');
        
    } catch (err) {
        console.error('Play error:', err);
        ctx.reply('❌ Database error. Try again later.');
    }
});

bot.command('balance', async (ctx) => {
    const userId = ctx.from.id;
    
    try {
        const registered = await isUserRegistered(userId);
        
        if (registered.registered) {
            return ctx.reply(
                `💰 Your Balance\n\n` +
                `Phone: ${registered.phone}\n` +
                `Balance: $${parseFloat(registered.user.wallet_balance).toFixed(2)}`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🎮 Play Now', callback_data: 'play_now' }]
                        ]
                    }
                }
            );
        }
        
        ctx.reply('❌ Not registered. Use /register first');
        
    } catch (err) {
        console.error('Balance error:', err);
        ctx.reply('❌ Error fetching balance');
    }
});

bot.action('play_now', async (ctx) => {
    ctx.deleteMessage();
    
    const registered = await isUserRegistered(ctx.from.id);
    if (registered.registered) {
        const autoLoginUrl = `${BASE_URL}/login.html?phone=${encodeURIComponent(registered.phone)}&auto=1`;
        
        await ctx.reply(
            `✅ Welcome back!\n\n` +
            `Click below to auto-login:`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🚀 Auto-Login', web_app: { url: autoLoginUrl } }]
                    ]
                }
            }
        );
    }
});

bot.action('cancel', (ctx) => {
    sessions.delete(ctx.from.id);
    ctx.editMessageText('❌ Cancelled');
});

bot.catch((err, ctx) => {
    console.error('❌ Bot error:', err);
});

async function startBot() {
    bot.launch();
    console.log('🤖 Telegram bot running...');
    console.log('📱 Send /start to begin');
    console.log('✅ Referral system added - /invite to get your link');
}

startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));