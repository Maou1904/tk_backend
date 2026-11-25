require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const { initializeStoreOperations, registerStoreOperations, transferClosingTotals, transferRecordsByDateRange } = require('./store-operations');
const { registerGasVoiceAI } = require('./gas-voice-ai');

const app = express();
app.use(cors());
app.use(express.json());
const scanSessions = new Map();
let scanEventId = 1;
const port = Number(process.env.PORT || 5000);

const databaseConfig = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        user: process.env.DB_USER || process.env.PGUSER,
        host: process.env.DB_HOST || process.env.PGHOST,
        database: process.env.DB_NAME || process.env.PGDATABASE,
        password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
        port: process.env.DB_PORT || process.env.PGPORT,
    };
const pool = new Pool({ ...databaseConfig, connectionTimeoutMillis: 5000 });

function logDatabaseError(context, error) {
    const causes = error.errors?.length ? error.errors : [error];
    for (const cause of causes) {
        console.error(`${context}${cause.code ? ` [${cause.code}]` : ''}:`, cause.message || cause.name);
    }
}

pool.on('error', (error) => logDatabaseError('Idle database connection failed', error));

const USER_ROLES = new Set(['owner', 'user']);
const OWNER_ROLE = 'owner';
const USER_ROLE = 'user';
const SESSION_PENDING_OPEN = 'PENDING_OPEN';
const LOTTERY_PENDING = 'รอเจ้าของร้านยืนยัน';
const SESSION_OPEN = 'OPEN';
const SESSION_CLOSED = 'CLOSED';
const LEGACY_OPEN_STATUS = 'ACTIVE';
const CLOSING_SECTIONS = ['POS', 'GAS', 'LOTTERY', 'TOPUP', 'TRANSFER', 'STOCK'];
const PASSWORD_ITERATIONS = 120000;
const SESSION_TTL_DAYS = 14;

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.pbkdf2Sync(String(password), salt, PASSWORD_ITERATIONS, 64, 'sha512').toString('hex');
    return { salt, hash };
}

function verifyPassword(password, user) {
    const expected = crypto.pbkdf2Sync(
        String(password),
        user.password_salt,
        PASSWORD_ITERATIONS,
        64,
        'sha512',
    ).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(user.password_hash, 'hex'));
}

function sanitizeUser(row) {
    if (!row) {
        return null;
    }

    return {
        id: Number(row.id),
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        active: Boolean(row.active),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function actorFromRequest(req) {
    return req.user
        ? {
            id: req.user.id,
            name: req.user.display_name || req.user.username,
            role: req.user.role,
        }
        : {
            id: null,
            name: 'system',
            role: 'system',
        };
}

function requireOwner(req, res, next) {
    if (req.user?.role !== OWNER_ROLE) {
        return res.status(403).json({ error: 'Owner permission is required' });
    }

    next();
}

async function requireAuth(req, res, next) {
    if (req.method === 'OPTIONS') {
        return next();
    }

    const authorization = String(req.headers.authorization || '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!token) {
        return res.status(401).json({ error: 'Login is required' });
    }

    try {
        const result = await pool.query(`
            SELECT
                u.id,
                u.username,
                u.display_name,
                u.role,
                u.active,
                u.created_at,
                u.updated_at
            FROM app_user_sessions s
            JOIN app_users u ON u.id = s.user_id
            WHERE s.token_hash = $1
              AND s.expires_at > NOW()
              AND u.active = TRUE
            LIMIT 1
        `, [sha256(token)]);

        const user = result.rows[0];
        if (!user) {
            return res.status(401).json({ error: 'Login session expired' });
        }

        req.user = sanitizeUser(user);
        await pool.query('UPDATE app_user_sessions SET last_seen_at = NOW() WHERE token_hash = $1', [sha256(token)]);
        next();
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    }
}

function dateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function businessDateKey(value) {
    if (!value) {
        return dateKey();
    }
    if (typeof value === 'string') {
        return value.slice(0, 10);
    }
    return dateKey(new Date(value));
}

function dailySessionId(date = new Date()) {
    return `TK-${dateKey(date).replace(/-/g, '')}`;
}

function timeLabel(value) {
    return new Intl.DateTimeFormat('th-TH', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Bangkok',
    }).format(new Date(value));
}

function createSaleId(prefix, date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');
    return `${prefix}-${year}${month}${day}-${hour}${minute}${second}`;
}

function createTopupId(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');
    return `TOPUP-${year}${month}${day}-${hour}${minute}${second}`;
}

async function initializeCartTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS categories (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS products (
            id SERIAL PRIMARY KEY,
            barcode TEXT UNIQUE,
            name TEXT NOT NULL,
            price NUMERIC(12, 2) NOT NULL DEFAULT 0,
            cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
            stock INTEGER NOT NULL DEFAULT 0,
            category_id INTEGER REFERENCES categories(id),
            min_stock INTEGER NOT NULL DEFAULT 5,
            unit TEXT NOT NULL DEFAULT 'piece',
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query('ALTER TABLE products ALTER COLUMN barcode DROP NOT NULL');

    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS min_stock INTEGER NOT NULL DEFAULT 5`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'piece'`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_users (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            role VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'user')),
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_user_sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS product_registration_requests (
            id SERIAL PRIMARY KEY,
            barcode TEXT NOT NULL,
            name TEXT NOT NULL,
            price NUMERIC(12, 2) NOT NULL DEFAULT 0,
            cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
            stock INTEGER NOT NULL DEFAULT 0,
            category TEXT NOT NULL DEFAULT '',
            min_stock INTEGER NOT NULL DEFAULT 5,
            unit TEXT NOT NULL DEFAULT 'piece',
            status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
            requested_by INTEGER REFERENCES app_users(id),
            reviewed_by INTEGER REFERENCES app_users(id),
            accepted_product_id INTEGER REFERENCES products(id),
            review_reason TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            reviewed_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_product_registration_requests_pending_barcode
        ON product_registration_requests (barcode)
        WHERE status = 'PENDING'
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_product_registration_requests_status_created
        ON product_registration_requests (status, created_at DESC)
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS staff_members (
            id VARCHAR(40) PRIMARY KEY,
            name TEXT NOT NULL,
            phone TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL DEFAULT 'staff',
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);



    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_sessions (
            session_id VARCHAR(80) PRIMARY KEY,
            business_date DATE NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'PENDING_OPEN',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`ALTER TABLE app_sessions ALTER COLUMN status SET DEFAULT 'PENDING_OPEN'`);
    await pool.query(`ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS opened_by INTEGER REFERENCES app_users(id)`);
    await pool.query(`ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE app_sessions ADD COLUMN IF NOT EXISTS closed_by INTEGER REFERENCES app_users(id)`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_session_closing_checks (
            session_id VARCHAR(80) NOT NULL REFERENCES app_sessions(session_id) ON DELETE CASCADE,
            section VARCHAR(20) NOT NULL,
            confirmed BOOLEAN NOT NULL DEFAULT FALSE,
            confirmed_by INTEGER REFERENCES app_users(id),
            confirmed_at TIMESTAMPTZ,
            note TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (session_id, section)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS pos_cart_sessions (
            session_id VARCHAR(80) PRIMARY KEY,
            status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS pos_cart_items (
            id SERIAL PRIMARY KEY,
            session_id VARCHAR(80) NOT NULL REFERENCES pos_cart_sessions(session_id) ON DELETE CASCADE,
            product_id INTEGER REFERENCES products(id),
            barcode TEXT NOT NULL,
            name TEXT NOT NULL,
            price NUMERIC(12, 2) NOT NULL DEFAULT 0,
            quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
            discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
            item_type VARCHAR(20) NOT NULL DEFAULT 'PRODUCT',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (session_id, product_id)
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_pos_cart_items_session_id
        ON pos_cart_items (session_id)
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS sales_records (
            id VARCHAR(80) PRIMARY KEY,
            session_id VARCHAR(80) NOT NULL REFERENCES app_sessions(session_id) ON DELETE CASCADE,
            channel VARCHAR(20) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            customer_name TEXT NOT NULL,
            staff_name TEXT NOT NULL,
            payment_method TEXT NOT NULL,
            status TEXT NOT NULL,
            items JSONB NOT NULL DEFAULT '[]'::jsonb,
            subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
            discount NUMERIC(12, 2) NOT NULL DEFAULT 0,
            total NUMERIC(12, 2) NOT NULL DEFAULT 0,
            cash_received NUMERIC(12, 2) NOT NULL DEFAULT 0,
            change NUMERIC(12, 2) NOT NULL DEFAULT 0,
            note TEXT
        )
    `);

    await pool.query(`ALTER TABLE sales_records ADD COLUMN IF NOT EXISTS cancel_reason TEXT`);
    await pool.query(`ALTER TABLE sales_records ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE sales_records ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES app_users(id)`);
    await pool.query(`ALTER TABLE sales_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_sales_records_session_created
        ON sales_records (session_id, created_at DESC)
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS receipt_print_requests (
            id SERIAL PRIMARY KEY,
            session_id VARCHAR(80) NOT NULL REFERENCES app_sessions(session_id) ON DELETE CASCADE,
            sale_id VARCHAR(80) NOT NULL REFERENCES sales_records(id) ON DELETE CASCADE,
            channel VARCHAR(20) NOT NULL,
            receipt_json JSONB NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
            requested_by VARCHAR(40) NOT NULL DEFAULT 'web',
            requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            printed_at TIMESTAMPTZ
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_receipt_print_requests_session_status
        ON receipt_print_requests (session_id, status, requested_at ASC)
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS gas_items (
            id VARCHAR(40) PRIMARY KEY,
            name TEXT NOT NULL,
            operation TEXT NOT NULL,
            price NUMERIC(12, 2) NOT NULL DEFAULT 0,
            stock INTEGER NOT NULL DEFAULT 0,
            image_url TEXT,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`ALTER TABLE gas_items ADD COLUMN IF NOT EXISTS full_stock INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE gas_items ADD COLUMN IF NOT EXISTS empty_stock INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE gas_items ADD COLUMN IF NOT EXISTS brand TEXT NOT NULL DEFAULT '' CHECK (brand IN ('', 'สยาม', 'ปตท'))`);
    // Only classify legacy rows when their existing labels identify one brand.
    // Unlabelled/shared stock must be assigned by the owner, never duplicated.
    await pool.query(`
        WITH legacy AS (
            SELECT id,
                concat_ws(' ', id, name, operation) ~* '(สยาม|(^|[^a-z])siam([^a-z]|$))' AS siam,
                concat_ws(' ', id, name, operation) ~* '(ปตท|(^|[^a-z])ptt([^a-z]|$))' AS ptt
            FROM gas_items WHERE brand = ''
        )
        UPDATE gas_items g SET brand = CASE WHEN legacy.siam THEN 'สยาม' ELSE 'ปตท' END
        FROM legacy WHERE g.id = legacy.id AND legacy.siam <> legacy.ptt
    `);
    await pool.query(`
        UPDATE gas_items
        SET full_stock = CASE
                WHEN COALESCE(full_stock, 0) = 0 AND COALESCE(stock, 0) > 0 THEN COALESCE(stock, 0)
                ELSE COALESCE(full_stock, 0)
            END,
            stock = CASE
                WHEN COALESCE(full_stock, 0) = 0 AND COALESCE(stock, 0) > 0 THEN COALESCE(stock, 0)
                ELSE COALESCE(full_stock, 0)
            END
        WHERE COALESCE(full_stock, 0) <> COALESCE(stock, 0)
           OR (COALESCE(full_stock, 0) = 0 AND COALESCE(stock, 0) > 0)
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS gas_jobs (
            id VARCHAR(80) PRIMARY KEY,
            session_id VARCHAR(80) NOT NULL REFERENCES app_sessions(session_id) ON DELETE CASCADE,
            customer_name TEXT NOT NULL,
            phone TEXT NOT NULL,
            address TEXT NOT NULL,
            driver TEXT NOT NULL,
            total NUMERIC(12, 2) NOT NULL DEFAULT 0,
            delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 0,
            returned_tank_quantity INTEGER NOT NULL DEFAULT 0,
            empty_tank_returned BOOLEAN NOT NULL DEFAULT TRUE,
            paid BOOLEAN NOT NULL DEFAULT TRUE,
            status TEXT NOT NULL DEFAULT 'กำลังดำเนินการ',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ
        )
    `);

    await pool.query(`
        ALTER TABLE gas_jobs
        ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE gas_jobs
        ADD COLUMN IF NOT EXISTS returned_tank_quantity INTEGER NOT NULL DEFAULT 0
    `);

    await pool.query(`
        ALTER TABLE gas_jobs
        ADD COLUMN IF NOT EXISTS empty_tank_returned BOOLEAN NOT NULL DEFAULT TRUE
    `);

    await pool.query(`
        ALTER TABLE gas_jobs
        ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT TRUE
    `);

    await pool.query(`
        ALTER TABLE gas_jobs
        ADD COLUMN IF NOT EXISTS cancel_reason TEXT
    `);

    await pool.query(`
        ALTER TABLE gas_jobs
        ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ
    `);

    await pool.query(`
        ALTER TABLE gas_jobs
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_gas_jobs_session_created
        ON gas_jobs (session_id, created_at DESC)
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS gas_job_items (
            id SERIAL PRIMARY KEY,
            job_id VARCHAR(80) NOT NULL REFERENCES gas_jobs(id) ON DELETE CASCADE,
            gas_item_id VARCHAR(40) REFERENCES gas_items(id),
            name TEXT NOT NULL,
            operation TEXT NOT NULL,
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            price NUMERIC(12, 2) NOT NULL DEFAULT 0
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS gas_returns (
            id VARCHAR(100) PRIMARY KEY,
            session_id VARCHAR(80) NOT NULL REFERENCES app_sessions(session_id) ON DELETE CASCADE,
            job_id VARCHAR(80) REFERENCES gas_jobs(id) ON DELETE CASCADE,
            gas_item_id VARCHAR(40) REFERENCES gas_items(id),
            customer_name TEXT NOT NULL,
            phone TEXT NOT NULL,
            tank_name TEXT NOT NULL,
            borrowed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
            returned_at TIMESTAMPTZ
        )
    `);

    await pool.query(`ALTER TABLE gas_returns ADD COLUMN IF NOT EXISTS returned_quantity INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE gas_returns ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_gas_returns_session_status
        ON gas_returns (session_id, status, borrowed_at DESC)
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS lottery_tickets (
            id SERIAL PRIMARY KEY,
            number VARCHAR(6) NOT NULL UNIQUE,
            series TEXT NOT NULL DEFAULT 'Manual',
            price NUMERIC(12, 2) NOT NULL DEFAULT 0,
            remaining INTEGER NOT NULL DEFAULT 0,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS lottery_cart_sessions (
            session_id VARCHAR(80) PRIMARY KEY REFERENCES app_sessions(session_id) ON DELETE CASCADE,
            status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS lottery_cart_items (
            id SERIAL PRIMARY KEY,
            session_id VARCHAR(80) NOT NULL REFERENCES lottery_cart_sessions(session_id) ON DELETE CASCADE,
            ticket_id INTEGER NOT NULL REFERENCES lottery_tickets(id),
            number VARCHAR(6) NOT NULL,
            series TEXT NOT NULL DEFAULT 'Manual',
            price NUMERIC(12, 2) NOT NULL DEFAULT 0,
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (session_id, ticket_id)
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_lottery_cart_items_session_id
        ON lottery_cart_items (session_id)
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS mobile_topup_orders (
            id VARCHAR(80) PRIMARY KEY,
            session_id VARCHAR(80) NOT NULL REFERENCES app_sessions(session_id) ON DELETE CASCADE,
            provider VARCHAR(20) NOT NULL,
            phone TEXT NOT NULL,
            amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
            topped_up BOOLEAN NOT NULL DEFAULT FALSE,
            paid BOOLEAN NOT NULL DEFAULT FALSE,
            status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
            cancel_reason TEXT,
            created_by INTEGER REFERENCES app_users(id),
            cancelled_by INTEGER REFERENCES app_users(id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            cancelled_at TIMESTAMPTZ
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_mobile_topup_orders_session_created
        ON mobile_topup_orders (session_id, created_at DESC)
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS inventory_movements (
            id SERIAL PRIMARY KEY,
            item_type VARCHAR(20) NOT NULL,
            item_id TEXT NOT NULL,
            item_name TEXT NOT NULL,
            delta INTEGER NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            source_type VARCHAR(40) NOT NULL,
            source_id TEXT NOT NULL,
            reversed_from INTEGER REFERENCES inventory_movements(id),
            created_by INTEGER REFERENCES app_users(id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS stock_kind VARCHAR(20) NOT NULL DEFAULT 'GENERAL'`);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_inventory_movements_source
        ON inventory_movements (source_type, source_id)
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id SERIAL PRIMARY KEY,
            actor_user_id INTEGER REFERENCES app_users(id),
            actor_name TEXT NOT NULL DEFAULT 'system',
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            reason TEXT,
            before_data JSONB,
            after_data JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
        ON audit_logs (entity_type, entity_id, created_at DESC)
    `);

    await pool.query(`
        ALTER TABLE lottery_tickets ADD COLUMN IF NOT EXISTS stock_reference INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE sales_records ADD COLUMN IF NOT EXISTS submitted_by INTEGER REFERENCES app_users(id);
        ALTER TABLE sales_records ADD COLUMN IF NOT EXISTS submitted_by_name TEXT;
        ALTER TABLE sales_records ADD COLUMN IF NOT EXISTS reported_cash_received NUMERIC(12,2);
        ALTER TABLE sales_records ADD COLUMN IF NOT EXISTS confirmed_by INTEGER REFERENCES app_users(id);
        ALTER TABLE sales_records ADD COLUMN IF NOT EXISTS confirmed_by_name TEXT;
        ALTER TABLE sales_records ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
        WITH movements AS (
            SELECT item_id, delta,
                SUM(delta) OVER (PARTITION BY item_id ORDER BY id ROWS UNBOUNDED PRECEDING) AS balance_delta,
                SUM(delta) OVER (PARTITION BY item_id) AS net_delta
            FROM inventory_movements WHERE item_type = 'LOTTERY'
        ), peaks AS (
            SELECT item_id, GREATEST(0, MAX(balance_delta)) - MAX(net_delta) AS peak_offset
            FROM movements GROUP BY item_id
        )
        UPDATE lottery_tickets t SET stock_reference = GREATEST(t.remaining, t.remaining + p.peak_offset)
        FROM peaks p WHERE p.item_id = t.id::text AND t.stock_reference = 0;
        UPDATE lottery_tickets SET stock_reference = remaining WHERE stock_reference < remaining;
    `);

    await initializeStoreOperations(pool);
    await ensureDefaultOwner();
    await ensureDefaultStaff();
}

async function ensureDefaultOwner() {
    const existingOwner = await pool.query("SELECT id FROM app_users WHERE role = 'owner' LIMIT 1");
    if (existingOwner.rows[0]) {
        return;
    }

    const username = process.env.DEFAULT_OWNER_USERNAME || 'owner';
    const password = process.env.DEFAULT_OWNER_PASSWORD || 'owner1234';
    const displayName = process.env.DEFAULT_OWNER_NAME || 'Owner';
    const { salt, hash } = hashPassword(password);

    await pool.query(`
        INSERT INTO app_users (username, display_name, password_hash, password_salt, role, active)
        VALUES ($1, $2, $3, $4, 'owner', TRUE)
        ON CONFLICT (username) DO NOTHING
    `, [username, displayName, hash, salt]);
}

async function ensureDefaultStaff() {
    const result = await pool.query('SELECT id FROM staff_members LIMIT 1');
    if (result.rows[0]) {
        return;
    }

    await pool.query(`
        INSERT INTO staff_members (id, name, phone, role, active)
        VALUES ('S-001', 'Owner', '', 'owner', TRUE)
        ON CONFLICT (id) DO NOTHING
    `);
}

function mapStaff(row) {
    return {
        id: row.id,
        name: row.name,
        phone: row.phone || '',
        role: row.role || 'staff',
        active: Boolean(row.active),
    };
}

function normalizeAppSessionStatus(status) {
    return status === LEGACY_OPEN_STATUS ? SESSION_OPEN : status;
}

function isOpenSessionStatus(status) {
    return normalizeAppSessionStatus(status) === SESSION_OPEN;
}

function mapAppSession(row) {
    return {
        session_id: row.session_id,
        business_date: businessDateKey(row.business_date),
        status: normalizeAppSessionStatus(row.status),
        rawStatus: row.status,
        openedAt: row.opened_at || null,
        closedAt: row.closed_at || null,
        openedBy: row.opened_by === undefined || row.opened_by === null ? null : Number(row.opened_by),
        closedBy: row.closed_by === undefined || row.closed_by === null ? null : Number(row.closed_by),
    };
}

function mapProduct(row) {
    return {
        id: Number(row.id),
        barcode: row.barcode ?? '',
        name: row.name,
        price: Number(row.price),
        cost: row.cost === undefined || row.cost === null ? undefined : Number(row.cost),
        stock: Number(row.stock),
        category_id: row.category_id,
        category: row.category || null,
        min_stock: row.min_stock === undefined || row.min_stock === null ? 5 : Number(row.min_stock),
        unit: row.unit || 'piece',
        active: row.active === undefined ? true : Boolean(row.active),
    };
}

function productDraftFromBody(body) {
    const price = Number(body.price);
    const cost = Number(body.cost || body.price || 0);
    const stock = Math.max(0, Math.floor(Number(body.stock || 0)));
    const minStock = Math.max(0, Math.floor(Number(body.minStock || body.min_stock || 5)));

    return {
        barcode: String(body.barcode || '').trim(),
        name: String(body.name || '').trim(),
        price,
        cost,
        stock,
        category: String(body.category || '').trim(),
        minStock,
        unit: String(body.unit || 'piece').trim() || 'piece',
    };
}

function validateProductDraft(draft, allowMissingBarcode = false) {
    return Boolean((allowMissingBarcode || draft.barcode) && draft.name &&
        Number.isFinite(draft.price) && (allowMissingBarcode ? draft.price >= 0 : draft.price > 0));
}

function mapProductRegistrationRequest(row) {
    return {
        id: Number(row.id),
        barcode: row.barcode,
        name: row.name,
        price: Number(row.price),
        cost: Number(row.cost),
        stock: Number(row.stock),
        category: row.category || '',
        minStock: Number(row.min_stock ?? 5),
        unit: row.unit || 'piece',
        status: row.status,
        requestedBy: row.requested_by === undefined || row.requested_by === null ? null : Number(row.requested_by),
        requestedByName: row.requested_by_name || 'system',
        reviewedBy: row.reviewed_by === undefined || row.reviewed_by === null ? null : Number(row.reviewed_by),
        reviewedByName: row.reviewed_by_name || '',
        acceptedProductId: row.accepted_product_id === undefined || row.accepted_product_id === null ? null : Number(row.accepted_product_id),
        reviewReason: row.review_reason || '',
        createdAt: row.created_at,
        reviewedAt: row.reviewed_at || null,
    };
}

function mapLotteryTicket(row) {
    return {
        id: Number(row.id),
        number: row.number,
        series: row.series || 'Manual',
        price: Number(row.price),
        remaining: Number(row.remaining),
        stockReference: Number(row.stock_reference ?? row.remaining),
        active: Boolean(row.active),
    };
}

function mapTopupOrder(row) {
    return {
        id: row.id,
        provider: row.provider,
        phone: row.phone,
        amount: Number(row.amount),
        toppedUp: Boolean(row.topped_up),
        paid: Boolean(row.paid),
        status: row.status,
        cancelReason: row.cancel_reason || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        cancelledAt: row.cancelled_at,
    };
}

function resolveTopupSaleStatus(row) {
    if (row.status === 'CANCELLED') {
        return 'CANCELLED';
    }

    return row.topped_up && row.paid ? 'completed' : 'pending';
}

function mapTopupSaleRecord(row) {
    const amount = Number(row.amount);
    const provider = row.provider || 'TOPUP';
    const phone = row.phone || '';
    return {
        id: row.id,
        channel: 'TOPUP',
        createdAt: row.created_at,
        customerName: phone || 'Walk-in',
        staffName: row.created_by_name || 'system',
        paymentMethod: 'เงินสด',
        status: resolveTopupSaleStatus(row),
        items: [
            {
                id: row.id,
                name: `Topup ${provider}`,
                barcode: phone,
                quantity: 1,
                price: amount,
                discount: 0,
            },
        ],
        subtotal: amount,
        discount: 0,
        total: amount,
        cashReceived: row.paid ? amount : 0,
        change: 0,
        note: [
            `Provider: ${provider}`,
            phone ? `Phone: ${phone}` : '',
            row.topped_up ? 'Topped up' : 'Pending topup',
            row.paid ? 'Paid' : 'Unpaid',
        ].filter(Boolean).join(' | '),
        cancelReason: row.cancel_reason || undefined,
        cancelledAt: row.cancelled_at || undefined,
    };
}

function mapInventoryMovement(row) {
    return {
        id: String(row.id),
        productName: row.item_name,
        itemType: row.item_type,
        itemId: row.item_id,
        stockKind: row.stock_kind || 'GENERAL',
        delta: Number(row.delta),
        reason: row.reason || '',
        staffName: row.actor_name || 'system',
        createdAt: row.created_at,
        date: dateKey(new Date(row.created_at)),
        sourceType: row.source_type,
        sourceId: row.source_id,
    };
}

function normalizeGasStockKind(value) {
    return String(value || 'FULL').trim().toUpperCase() === 'EMPTY' ? 'EMPTY' : 'FULL';
}

function gasStockKindText(stockKind) {
    return normalizeGasStockKind(stockKind) === 'EMPTY' ? 'empty tank' : 'full tank';
}

async function logAudit(client, req, action, entityType, entityId, reason, beforeData, afterData) {
    const actor = actorFromRequest(req);
    await client.query(`
        INSERT INTO audit_logs (
            actor_user_id,
            actor_name,
            action,
            entity_type,
            entity_id,
            reason,
            before_data,
            after_data
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
    `, [
        actor.id,
        actor.name,
        action,
        entityType,
        String(entityId),
        reason || null,
        beforeData === undefined ? null : JSON.stringify(beforeData),
        afterData === undefined ? null : JSON.stringify(afterData),
    ]);
}

async function recordInventoryMovement(client, req, movement) {
    const actor = actorFromRequest(req);
    await client.query(`
        INSERT INTO inventory_movements (
            item_type,
            item_id,
            item_name,
            delta,
            reason,
            source_type,
            source_id,
            reversed_from,
            stock_kind,
            created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
        movement.itemType,
        String(movement.itemId),
        movement.itemName,
        Math.trunc(Number(movement.delta)),
        movement.reason || '',
        movement.sourceType,
        String(movement.sourceId),
        movement.reversedFrom || null,
        movement.stockKind || 'GENERAL',
        actor.id,
    ]);
}

async function adjustProductStock(client, req, productId, delta, reason, sourceType, sourceId, reversedFrom = null) {
    const result = await client.query(`
        UPDATE products
        SET stock = GREATEST(0, COALESCE(stock, 0) + $1),
            updated_at = NOW()
        WHERE id = $2
        RETURNING id, name, stock
    `, [Math.trunc(Number(delta)), Number(productId)]);

    if (!result.rows[0]) {
        const error = new Error('product not found');
        error.statusCode = 404;
        throw error;
    }

    await recordInventoryMovement(client, req, {
        itemType: 'PRODUCT',
        itemId: productId,
        itemName: result.rows[0].name,
        delta,
        reason,
        sourceType,
        sourceId,
        reversedFrom,
    });

    return result.rows[0];
}

async function adjustGasStock(client, req, gasItemId, delta, reason, sourceType, sourceId, reversedFrom = null, stockKind = 'FULL') {
    const normalizedDelta = Math.trunc(Number(delta));
    const normalizedStockKind = normalizeGasStockKind(stockKind);
    const currentResult = await client.query(`
        SELECT id, name, operation, brand, stock, full_stock, empty_stock
        FROM gas_items
        WHERE id = $1
        FOR UPDATE
    `, [String(gasItemId)]);
    const current = currentResult.rows[0];

    if (!current) {
        const error = new Error('gas item not found');
        error.statusCode = 404;
        throw error;
    }

    const currentStock = normalizedStockKind === 'EMPTY'
        ? Number(current.empty_stock || 0)
        : Number(current.full_stock ?? current.stock ?? 0);
    if (currentStock + normalizedDelta < 0) {
        const error = new Error(`${gasStockKindText(normalizedStockKind)} stock is not enough`);
        error.statusCode = 409;
        throw error;
    }

    const result = await client.query(`
        UPDATE gas_items
        SET full_stock = CASE
                WHEN $3 = 'EMPTY' THEN COALESCE(full_stock, COALESCE(stock, 0))
                ELSE COALESCE(full_stock, COALESCE(stock, 0)) + $1
            END,
            empty_stock = CASE
                WHEN $3 = 'EMPTY' THEN COALESCE(empty_stock, 0) + $1
                ELSE COALESCE(empty_stock, 0)
            END,
            stock = CASE
                WHEN $3 = 'EMPTY' THEN COALESCE(full_stock, COALESCE(stock, 0))
                ELSE COALESCE(full_stock, COALESCE(stock, 0)) + $1
            END,
            updated_at = NOW()
        WHERE id = $2
        RETURNING id, name, operation, brand, stock, full_stock, empty_stock
    `, [normalizedDelta, String(gasItemId), normalizedStockKind]);

    await recordInventoryMovement(client, req, {
        itemType: 'GAS',
        itemId: gasItemId,
        itemName: `${result.rows[0].name} ${result.rows[0].operation}`,
        delta: normalizedDelta,
        reason,
        sourceType,
        sourceId,
        reversedFrom,
        stockKind: normalizedStockKind,
    });

    return result.rows[0];
}

async function adjustLotteryStock(client, req, ticketId, delta, reason, sourceType, sourceId, reversedFrom = null) {
    const result = await client.query(`
        UPDATE lottery_tickets
        SET stock_reference = GREATEST(COALESCE(stock_reference, 0), COALESCE(remaining, 0) + $1),
            remaining = GREATEST(0, COALESCE(remaining, 0) + $1),
            updated_at = NOW()
        WHERE id = $2
        RETURNING id, number, series, remaining
    `, [Math.trunc(Number(delta)), Number(ticketId)]);

    if (!result.rows[0]) {
        const error = new Error('lottery ticket not found');
        error.statusCode = 404;
        throw error;
    }

    await recordInventoryMovement(client, req, {
        itemType: 'LOTTERY',
        itemId: ticketId,
        itemName: `${result.rows[0].number} ${result.rows[0].series}`,
        delta,
        reason,
        sourceType,
        sourceId,
        reversedFrom,
    });

    return result.rows[0];
}

async function reverseInventoryMovements(client, req, sourceType, sourceId, reason) {
    const result = await client.query(`
        SELECT m.*
        FROM inventory_movements m
        WHERE m.source_type = $1
          AND m.source_id = $2
          AND NOT EXISTS (
              SELECT 1
              FROM inventory_movements r
              WHERE r.reversed_from = m.id
          )
        ORDER BY m.id DESC
    `, [sourceType, String(sourceId)]);

    for (const movement of result.rows) {
        const reverseDelta = -Number(movement.delta);
        if (movement.item_type === 'PRODUCT') {
            await adjustProductStock(client, req, Number(movement.item_id), reverseDelta, reason, `${sourceType}_REVERSAL`, sourceId, movement.id);
        } else if (movement.item_type === 'GAS') {
            await adjustGasStock(client, req, movement.item_id, reverseDelta, reason, `${sourceType}_REVERSAL`, sourceId, movement.id, normalizeGasStockKind(movement.stock_kind));
        } else if (movement.item_type === 'LOTTERY') {
            await adjustLotteryStock(client, req, Number(movement.item_id), reverseDelta, reason, `${sourceType}_REVERSAL`, sourceId, movement.id);
        }
    }

    return result.rows.length;
}

async function ensureCategory(name, client = pool) {
    const existingCategory = await client.query('SELECT id FROM categories WHERE name = $1 LIMIT 1', [name]);
    if (existingCategory.rows[0]) {
        return existingCategory.rows[0].id;
    }

    const categoryResult = await client.query('INSERT INTO categories (name) VALUES ($1) RETURNING id', [name]);
    return categoryResult.rows[0].id;
}

async function createProductFromDraft(client, req, draft, reason) {
    const existingProduct = await client.query('SELECT id, active FROM products WHERE barcode = $1 LIMIT 1', [draft.barcode]);
    if (existingProduct.rows[0]?.active) {
        const error = new Error('Barcode already exists');
        error.statusCode = 409;
        throw error;
    }

    let categoryId = null;
    if (draft.category) {
        categoryId = await ensureCategory(draft.category, client);
    }

    const productResult = await client.query(`
        INSERT INTO products (barcode, name, price, cost, stock, category_id, min_stock, unit, active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
        ON CONFLICT (barcode)
        DO UPDATE SET
            name = EXCLUDED.name,
            price = EXCLUDED.price,
            cost = EXCLUDED.cost,
            stock = EXCLUDED.stock,
            category_id = EXCLUDED.category_id,
            min_stock = EXCLUDED.min_stock,
            unit = EXCLUDED.unit,
            active = TRUE,
            updated_at = NOW()
        WHERE NOT products.active
        RETURNING id, barcode, name, price, cost, stock, category_id, min_stock, unit, active
    `, [
        draft.barcode || null,
        draft.name,
        draft.price,
        draft.cost,
        draft.stock,
        categoryId,
        draft.minStock,
        draft.unit,
    ]);
    if (!productResult.rows[0]) {
        throw Object.assign(new Error('Barcode already exists'), { statusCode: 409 });
    }
    const product = { ...productResult.rows[0], category: draft.category || null };

    if (draft.stock > 0) {
        await recordInventoryMovement(client, req, {
            itemType: 'PRODUCT',
            itemId: product.id,
            itemName: product.name,
            delta: draft.stock,
            reason: reason || 'initial product stock',
            sourceType: 'PRODUCT_CREATE',
            sourceId: product.id,
        });
    }

    await logAudit(client, req, 'UPSERT', 'PRODUCT', product.id, reason || 'upsert product', null, mapProduct(product));
    return product;
}

function normalizeSessionId(sessionId) {
    return String(sessionId || '').trim().slice(0, 80);
}

async function ensureAppSession(sessionId, client = pool) {
    const normalizedSessionId = normalizeSessionId(sessionId || dailySessionId());
    if (!normalizedSessionId) {
        const error = new Error('session id is required');
        error.statusCode = 400;
        throw error;
    }

    const dateMatch = normalizedSessionId.match(/^TK-(\d{4})(\d{2})(\d{2})$/);
    const businessDate = dateMatch
        ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
        : dateKey();

    const result = await client.query(`
        INSERT INTO app_sessions (session_id, business_date, status)
        VALUES ($1, $2::date, $3)
        ON CONFLICT (session_id)
        DO UPDATE SET updated_at = NOW()
        RETURNING session_id, business_date, status, opened_at, opened_by, closed_at, closed_by
    `, [normalizedSessionId, businessDate, SESSION_PENDING_OPEN]);

    return mapAppSession(result.rows[0]);
}

async function ensureOpenAppSession(sessionId, client = pool) {
    const session = await ensureAppSession(sessionId, client);
    if (!isOpenSessionStatus(session.status)) {
        const error = new Error(session.status === SESSION_CLOSED ? 'shop is closed' : 'shop is not open');
        error.statusCode = 409;
        error.session = session;
        throw error;
    }

    return session;
}

function mapCartItem(row) {
    return {
        id: String(row.product_id || row.cart_row_id),
        name: row.name,
        barcode: row.barcode,
        price: Number(row.price),
        quantity: Number(row.quantity),
        discount: Number(row.discount),
        item_type: row.item_type,
    };
}

async function ensureCartSession(sessionId, client = pool) {
    const session = await ensureOpenAppSession(sessionId, client);
    const normalizedSessionId = session.session_id;

    await client.query(`
        INSERT INTO pos_cart_sessions (session_id)
        VALUES ($1)
        ON CONFLICT (session_id)
        DO UPDATE SET updated_at = NOW()
    `, [normalizedSessionId]);

    return normalizedSessionId;
}

function mapSaleRecord(row) {
    return {
        id: row.id,
        channel: row.channel,
        createdAt: row.created_at,
        customerName: row.customer_name,
        staffName: row.staff_name,
        paymentMethod: row.payment_method,
        status: row.status,
        submittedBy: row.submitted_by,
        submittedByName: row.submitted_by_name,
        reportedCashReceived: row.reported_cash_received == null ? undefined : Number(row.reported_cash_received),
        confirmedBy: row.confirmed_by,
        confirmedByName: row.confirmed_by_name,
        confirmedAt: row.confirmed_at,
        items: Array.isArray(row.items) ? row.items : [],
        subtotal: Number(row.subtotal),
        discount: Number(row.discount),
        total: Number(row.total),
        cashReceived: Number(row.cash_received),
        change: Number(row.change),
        note: row.note || undefined,
        cancelReason: row.cancel_reason || undefined,
        cancelledAt: row.cancelled_at || undefined,
    };
}

function mapGasItem(row) {
    const fullStock = Number(row.full_stock ?? row.stock ?? 0);
    const emptyStock = Number(row.empty_stock ?? 0);
    return {
        id: row.id,
        name: row.name,
        operation: row.operation,
        brand: row.brand || '',
        price: Number(row.price),
        stock: fullStock,
        fullStock,
        full_stock: fullStock,
        emptyStock,
        empty_stock: emptyStock,
        totalStock: fullStock + emptyStock,
        total_stock: fullStock + emptyStock,
        imageUrl: row.image_url || '',
        active: row.active === undefined ? true : Boolean(row.active),
    };
}

function mapPrintRequest(row) {
    return {
        id: row.id,
        session_id: row.session_id,
        sale_id: row.sale_id,
        channel: row.channel,
        receipt: {
            ...row.receipt_json,
            createdAt: row.receipt_json.createdAt || row.receipt_json.created_at,
        },
        status: row.status,
        requested_by: row.requested_by,
        requested_at: row.requested_at,
    };
}

async function getSalesRecords(sessionId, client = pool) {
    const result = await client.query(`
        SELECT *
        FROM sales_records
        WHERE session_id = $1
        ORDER BY created_at DESC
    `, [sessionId]);

    return result.rows.map(mapSaleRecord);
}

async function getTopupSaleRecords(sessionId, client = pool) {
    const result = await client.query(`
        SELECT
            t.*,
            COALESCE(u.display_name, u.username, 'system') AS created_by_name
        FROM mobile_topup_orders t
        LEFT JOIN app_users u ON u.id = t.created_by
        WHERE t.session_id = $1
        ORDER BY t.created_at DESC
    `, [sessionId]);

    return result.rows.map(mapTopupSaleRecord);
}

function sortSaleRecordsByCreatedAt(records) {
    return records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

async function getCombinedSaleRecords(sessionId, client = pool) {
    const sales = await getSalesRecords(sessionId, client);
    const topups = await getTopupSaleRecords(sessionId, client);

    return sortSaleRecordsByCreatedAt([...sales, ...topups]);
}

function dateFromUtcParts(year, month, day) {
    return new Date(Date.UTC(year, month - 1, day));
}

function dateKeyFromUtcDate(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function addUtcDays(dateString, days) {
    const [year, month, day] = dateString.split('-').map(Number);
    const date = dateFromUtcParts(year, month, day);
    date.setUTCDate(date.getUTCDate() + days);
    return dateKeyFromUtcDate(date);
}

function addUtcMonths(monthString, months) {
    const [year, month] = monthString.split('-').map(Number);
    const date = dateFromUtcParts(year, month, 1);
    date.setUTCMonth(date.getUTCMonth() + months);
    return dateKeyFromUtcDate(date);
}

function resolveAnalyticsRange(query) {
    const period = ['day', 'month', 'year'].includes(query.period) ? query.period : 'day';
    const today = dateKey();

    if (period === 'month') {
        const month = /^\d{4}-\d{2}$/.test(String(query.month || ''))
            ? String(query.month)
            : today.slice(0, 7);
        return {
            period,
            startDate: `${month}-01`,
            endDate: addUtcMonths(month, 1),
        };
    }

    if (period === 'year') {
        const year = /^\d{4}$/.test(String(query.year || ''))
            ? String(query.year)
            : today.slice(0, 4);
        return {
            period,
            startDate: `${year}-01-01`,
            endDate: `${Number(year) + 1}-01-01`,
        };
    }

    const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(query.date || ''))
        ? String(query.date)
        : today;
    return {
        period,
        startDate: selectedDate,
        endDate: addUtcDays(selectedDate, 1),
    };
}

async function getSalesRecordsByDateRange(startDate, endDate, client = pool) {
    const result = await client.query(`
        SELECT *
        FROM sales_records
        WHERE created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Bangkok')
          AND created_at < ($2::date::timestamp AT TIME ZONE 'Asia/Bangkok')
        ORDER BY created_at DESC
    `, [startDate, endDate]);

    return result.rows.map(mapSaleRecord);
}

async function getTopupSaleRecordsByDateRange(startDate, endDate, client = pool) {
    const result = await client.query(`
        SELECT
            t.*,
            COALESCE(u.display_name, u.username, 'system') AS created_by_name
        FROM mobile_topup_orders t
        LEFT JOIN app_users u ON u.id = t.created_by
        WHERE t.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Bangkok')
          AND t.created_at < ($2::date::timestamp AT TIME ZONE 'Asia/Bangkok')
        ORDER BY t.created_at DESC
    `, [startDate, endDate]);

    return result.rows.map(mapTopupSaleRecord);
}

async function getCombinedSaleRecordsByDateRange(startDate, endDate, client = pool) {
    const sales = await getSalesRecordsByDateRange(startDate, endDate, client);
    const topups = await getTopupSaleRecordsByDateRange(startDate, endDate, client);

    return sortSaleRecordsByCreatedAt([...sales, ...topups]);
}

async function getClosingChecks(sessionId, client = pool) {
    const result = await client.query(`
        SELECT
            c.section,
            c.confirmed,
            c.confirmed_at,
            c.note,
            COALESCE(u.display_name, u.username, '') AS confirmed_by_name
        FROM app_session_closing_checks c
        LEFT JOIN app_users u ON u.id = c.confirmed_by
        WHERE c.session_id = $1
    `, [sessionId]);

    const checks = new Map(CLOSING_SECTIONS.map((section) => [section, {
        section,
        confirmed: false,
        confirmedAt: null,
        confirmedBy: '',
        note: '',
    }]));

    result.rows.forEach((row) => {
        checks.set(row.section, {
            section: row.section,
            confirmed: Boolean(row.confirmed),
            confirmedAt: row.confirmed_at,
            confirmedBy: row.confirmed_by_name || '',
            note: row.note || '',
        });
    });

    return Array.from(checks.values());
}

async function getPreviousClosedSession(beforeBusinessDate, client = pool) {
    const result = await client.query(`
        SELECT session_id, business_date, status, opened_at, opened_by, closed_at, closed_by
        FROM app_sessions
        WHERE business_date < $1::date
          AND status = $2
        ORDER BY business_date DESC
        LIMIT 1
    `, [beforeBusinessDate, SESSION_CLOSED]);

    return result.rows[0] ? mapAppSession(result.rows[0]) : null;
}

async function getClosingSummary(sessionId, client = pool) {
    const session = await ensureAppSession(sessionId, client);
    const businessDate = businessDateKey(session.business_date);
    const nextBusinessDate = addUtcDays(businessDate, 1);

    const posTotalsResult = await client.query(`
        SELECT
            COUNT(*)::int AS bill_count,
            COALESCE(SUM(total), 0) AS total,
            COALESCE(SUM(subtotal), 0) AS subtotal,
            COALESCE(SUM(discount), 0) AS discount
        FROM sales_records
        WHERE session_id = $1
          AND channel = 'POS'
          AND status <> 'CANCELLED'
    `, [session.session_id]);

    const posItemsResult = await client.query(`
        SELECT
            item.value->>'name' AS name,
            COALESCE(item.value->>'barcode', '') AS barcode,
            COALESCE(SUM((item.value->>'quantity')::numeric), 0) AS quantity,
            COALESCE(SUM(
                GREATEST(
                    0,
                    COALESCE((item.value->>'price')::numeric, 0) * COALESCE((item.value->>'quantity')::numeric, 0)
                    - COALESCE((item.value->>'discount')::numeric, 0)
                )
            ), 0) AS total
        FROM sales_records s
        CROSS JOIN LATERAL jsonb_array_elements(s.items) AS item(value)
        WHERE s.session_id = $1
          AND s.channel = 'POS'
          AND s.status <> 'CANCELLED'
        GROUP BY item.value->>'name', COALESCE(item.value->>'barcode', '')
        ORDER BY quantity DESC, name ASC
        LIMIT 120
    `, [session.session_id]);

    const lotteryTotalsResult = await client.query(`
        SELECT
            COUNT(*)::int AS bill_count,
            COALESCE(SUM(total), 0) AS total
        FROM sales_records
        WHERE session_id = $1
          AND channel = 'LOTTERY'
          AND status NOT IN ('CANCELLED', '${LOTTERY_PENDING}')
    `, [session.session_id]);

    const lotteryItemsResult = await client.query(`
        SELECT
            COALESCE(item.value->>'number', item.value->>'barcode', item.value->>'name') AS number,
            COALESCE(SUM((item.value->>'quantity')::numeric), 0) AS quantity,
            COALESCE(SUM(COALESCE((item.value->>'price')::numeric, 0) * COALESCE((item.value->>'quantity')::numeric, 0)), 0) AS total
        FROM sales_records s
        CROSS JOIN LATERAL jsonb_array_elements(s.items) AS item(value)
        WHERE s.session_id = $1
          AND s.channel = 'LOTTERY'
          AND s.status NOT IN ('CANCELLED', '${LOTTERY_PENDING}')
        GROUP BY COALESCE(item.value->>'number', item.value->>'barcode', item.value->>'name')
        ORDER BY quantity DESC, number ASC
        LIMIT 120
    `, [session.session_id]);

    const gasTotalsResult = await client.query(`
        SELECT
            COUNT(*)::int AS job_count,
            COALESCE(SUM(total), 0) AS total,
            COALESCE(SUM(delivery_fee), 0) AS delivery_fee_total,
            COALESCE(SUM(returned_tank_quantity), 0) AS returned_tank_quantity,
            COALESCE(SUM(CASE WHEN paid THEN 1 ELSE 0 END), 0)::int AS paid_job_count,
            COALESCE(SUM(CASE WHEN NOT paid THEN 1 ELSE 0 END), 0)::int AS unpaid_job_count,
            COALESCE(SUM(CASE WHEN empty_tank_returned THEN 1 ELSE 0 END), 0)::int AS fully_returned_job_count,
            COALESCE(SUM(CASE WHEN NOT empty_tank_returned THEN 1 ELSE 0 END), 0)::int AS pending_return_job_count,
            COALESCE(SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS completed_job_count,
            COALESCE(SUM(CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END), 0)::int AS open_job_count
        FROM gas_jobs
        WHERE session_id = $1
          AND status <> 'CANCELLED'
    `, [session.session_id]);

    const gasItemsResult = await client.query(`
        SELECT
            COALESCE(i.gas_item_id, i.name) AS id,
            i.name,
            i.operation,
            COALESCE(SUM(i.quantity), 0) AS quantity,
            COALESCE(SUM(i.quantity * i.price), 0) AS total
        FROM gas_jobs j
        JOIN gas_job_items i ON i.job_id = j.id
        WHERE j.session_id = $1
          AND j.status <> 'CANCELLED'
        GROUP BY COALESCE(i.gas_item_id, i.name), i.name, i.operation
        ORDER BY quantity DESC, i.name ASC
    `, [session.session_id]);

    const gasPendingResult = await client.query(`
        SELECT
            COALESCE(gas_item_id, tank_name) AS id,
            tank_name,
            COALESCE(SUM(quantity), 0) AS quantity
        FROM gas_returns
        WHERE session_id = $1
          AND status = 'PENDING'
        GROUP BY COALESCE(gas_item_id, tank_name), tank_name
    `, [session.session_id]);

    const gasBalanceResult = await client.query(`
        WITH day_movements AS (
            SELECT
                *,
                CASE WHEN stock_kind = 'EMPTY' THEN 'EMPTY' ELSE 'FULL' END AS gas_stock_kind
            FROM inventory_movements
            WHERE item_type = 'GAS'
              AND created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Bangkok')
              AND created_at < ($2::date::timestamp AT TIME ZONE 'Asia/Bangkok')
        ),
        pending_returns AS (
            SELECT gas_item_id::text AS item_id, COALESCE(SUM(quantity), 0) AS pending_quantity
            FROM gas_returns
            WHERE session_id = $3
              AND status = 'PENDING'
              AND gas_item_id IS NOT NULL
            GROUP BY gas_item_id
        ),
        sold_items AS (
            SELECT i.gas_item_id::text AS item_id, COALESCE(SUM(i.quantity), 0) AS sold_quantity
            FROM gas_jobs j
            JOIN gas_job_items i ON i.job_id = j.id
            WHERE j.session_id = $3
              AND j.status <> 'CANCELLED'
              AND i.gas_item_id IS NOT NULL
            GROUP BY i.gas_item_id
        )
        SELECT
            g.id,
            g.name,
            g.operation,
            g.stock,
            g.full_stock,
            g.empty_stock,
            COALESCE(SUM(CASE WHEN dm.gas_stock_kind = 'FULL' THEN dm.delta ELSE 0 END), 0) AS full_movement_delta,
            COALESCE(SUM(CASE WHEN dm.gas_stock_kind = 'EMPTY' THEN dm.delta ELSE 0 END), 0) AS empty_movement_delta,
            COALESCE(si.sold_quantity, 0) AS sold_quantity,
            GREATEST(0, COALESCE(SUM(CASE WHEN dm.source_type IN ('GAS_JOB', 'GAS_JOB_REVERSAL') AND dm.gas_stock_kind = 'EMPTY' THEN dm.delta ELSE 0 END), 0)) AS returned_quantity,
            COALESCE(SUM(CASE WHEN dm.source_type NOT IN ('GAS_JOB', 'GAS_JOB_REVERSAL') AND dm.gas_stock_kind = 'FULL' THEN dm.delta ELSE 0 END), 0) AS full_adjusted_quantity,
            COALESCE(SUM(CASE WHEN dm.source_type NOT IN ('GAS_JOB', 'GAS_JOB_REVERSAL') AND dm.gas_stock_kind = 'EMPTY' THEN dm.delta ELSE 0 END), 0) AS empty_adjusted_quantity,
            COALESCE(pr.pending_quantity, 0) AS pending_quantity
        FROM gas_items g
        LEFT JOIN day_movements dm ON dm.item_id = g.id
        LEFT JOIN pending_returns pr ON pr.item_id = g.id
        LEFT JOIN sold_items si ON si.item_id = g.id
        WHERE g.active = TRUE OR dm.id IS NOT NULL OR pr.pending_quantity IS NOT NULL
        GROUP BY g.id, g.name, g.operation, g.stock, g.full_stock, g.empty_stock, pr.pending_quantity, si.sold_quantity
        ORDER BY g.price DESC, g.id ASC
    `, [businessDate, nextBusinessDate, session.session_id]);

    const topupResult = await client.query(`
        SELECT
            provider,
            COUNT(*)::int AS order_count,
            COALESCE(SUM(amount), 0) AS total,
            COALESCE(SUM(CASE WHEN paid THEN amount ELSE 0 END), 0) AS paid_total,
            COALESCE(SUM(CASE WHEN NOT paid THEN amount ELSE 0 END), 0) AS unpaid_total,
            COALESCE(SUM(CASE WHEN topped_up THEN 1 ELSE 0 END), 0)::int AS topped_up_count,
            COALESCE(SUM(CASE WHEN paid THEN 1 ELSE 0 END), 0)::int AS paid_count
        FROM mobile_topup_orders
        WHERE session_id = $1
          AND status <> 'CANCELLED'
        GROUP BY provider
        ORDER BY provider ASC
    `, [session.session_id]);

    const stockMovementResult = await client.query(`
        SELECT
            item_type,
            item_name,
            COALESCE(SUM(delta), 0) AS net_delta,
            COUNT(*)::int AS movement_count
        FROM inventory_movements
        WHERE created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Bangkok')
          AND created_at < ($2::date::timestamp AT TIME ZONE 'Asia/Bangkok')
        GROUP BY item_type, item_name
        ORDER BY item_type ASC, item_name ASC
        LIMIT 160
    `, [businessDate, nextBusinessDate]);

    const lowStockResult = await client.query(`
        SELECT p.id, p.barcode, p.name, p.price, p.cost, p.stock, p.category_id, p.min_stock, p.unit, p.active, c.name AS category
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.active = TRUE
          AND p.stock <= p.min_stock
        ORDER BY p.stock ASC, p.name ASC
        LIMIT 80
    `);

    const gasPendingQuantity = gasPendingResult.rows.reduce((sum, row) => sum + Number(row.quantity), 0);
    const gasSoldQuantity = gasItemsResult.rows.reduce((sum, row) => sum + Number(row.quantity), 0);
    const topupTotal = topupResult.rows.reduce((sum, row) => sum + Number(row.total), 0);
    const topupCount = topupResult.rows.reduce((sum, row) => sum + Number(row.order_count), 0);
    const transfers = await transferClosingTotals(client, session.session_id);
    const checks = (await getClosingChecks(session.session_id, client))
        .filter((check) => check.section !== 'TRANSFER' || transfers.records > 0);
    const readyToClose = isOpenSessionStatus(session.status) && checks.every((check) => check.confirmed);

    return {
        session,
        previousClosedSession: await getPreviousClosedSession(businessDate, client),
        checks,
        readyToClose,
        sections: {
            transfers,
            pos: {
                billCount: Number(posTotalsResult.rows[0].bill_count),
                itemCount: posItemsResult.rows.reduce((sum, row) => sum + Number(row.quantity), 0),
                subtotal: Number(posTotalsResult.rows[0].subtotal),
                discount: Number(posTotalsResult.rows[0].discount),
                total: Number(posTotalsResult.rows[0].total),
                items: posItemsResult.rows.map((row) => ({
                    name: row.name,
                    barcode: row.barcode,
                    quantity: Number(row.quantity),
                    total: Number(row.total),
                })),
            },
            gas: {
                jobCount: Number(gasTotalsResult.rows[0].job_count),
                soldQuantity: gasSoldQuantity,
                returnedQuantity: Number(gasTotalsResult.rows[0].returned_tank_quantity),
                pendingReturnQuantity: gasPendingQuantity,
                total: Number(gasTotalsResult.rows[0].total),
                deliveryFeeTotal: Number(gasTotalsResult.rows[0].delivery_fee_total),
                serviceStats: {
                    paidJobs: Number(gasTotalsResult.rows[0].paid_job_count),
                    unpaidJobs: Number(gasTotalsResult.rows[0].unpaid_job_count),
                    fullyReturnedJobs: Number(gasTotalsResult.rows[0].fully_returned_job_count),
                    pendingReturnJobs: Number(gasTotalsResult.rows[0].pending_return_job_count),
                    completedJobs: Number(gasTotalsResult.rows[0].completed_job_count),
                    openJobs: Number(gasTotalsResult.rows[0].open_job_count),
                },
                items: gasItemsResult.rows.map((row) => ({
                    id: row.id,
                    name: row.name,
                    operation: row.operation,
                    quantity: Number(row.quantity),
                    total: Number(row.total),
                })),
                pendingReturns: gasPendingResult.rows.map((row) => ({
                    id: row.id,
                    tankName: row.tank_name,
                    quantity: Number(row.quantity),
                })),
                tankBalance: gasBalanceResult.rows.map((row) => {
                    const fullStock = Number(row.full_stock ?? row.stock ?? 0);
                    const emptyStock = Number(row.empty_stock ?? 0);
                    const fullMovementDelta = Number(row.full_movement_delta);
                    const emptyMovementDelta = Number(row.empty_movement_delta);
                    const openingFullStock = fullStock - fullMovementDelta;
                    const openingEmptyStock = emptyStock - emptyMovementDelta;
                    const openingStock = openingFullStock + openingEmptyStock;
                    const currentStock = fullStock + emptyStock;
                    const adjustedFullQuantity = Number(row.full_adjusted_quantity);
                    const adjustedEmptyQuantity = Number(row.empty_adjusted_quantity);
                    const adjustedQuantity = adjustedFullQuantity + adjustedEmptyQuantity;
                    const idealStock = openingStock + adjustedQuantity;
                    const expectedMissing = idealStock - currentStock;
                    const pendingQuantity = Number(row.pending_quantity);
                    const status = expectedMissing <= 0
                        ? 'BALANCED'
                        : pendingQuantity === expectedMissing
                            ? 'PENDING_RETURN'
                            : 'MISMATCH';
                    return {
                        id: row.id,
                        name: row.name,
                        operation: row.operation,
                        openingStock,
                        openingFullStock,
                        openingEmptyStock,
                        openingTotalStock: openingStock,
                        currentStock,
                        currentFullStock: fullStock,
                        currentEmptyStock: emptyStock,
                        currentTotalStock: currentStock,
                        soldQuantity: Number(row.sold_quantity),
                        returnedQuantity: Number(row.returned_quantity),
                        adjustedQuantity,
                        adjustedFullQuantity,
                        adjustedEmptyQuantity,
                        pendingQuantity,
                        expectedMissing,
                        status,
                    };
                }),
            },
            lottery: {
                billCount: Number(lotteryTotalsResult.rows[0].bill_count),
                ticketCount: lotteryItemsResult.rows.reduce((sum, row) => sum + Number(row.quantity), 0),
                total: Number(lotteryTotalsResult.rows[0].total),
                items: lotteryItemsResult.rows.map((row) => ({
                    number: row.number,
                    quantity: Number(row.quantity),
                    total: Number(row.total),
                })),
            },
            topup: {
                orderCount: topupCount,
                total: topupTotal,
                providers: topupResult.rows.map((row) => ({
                    provider: row.provider,
                    orderCount: Number(row.order_count),
                    total: Number(row.total),
                    paidTotal: Number(row.paid_total),
                    unpaidTotal: Number(row.unpaid_total),
                    toppedUpCount: Number(row.topped_up_count),
                    paidCount: Number(row.paid_count),
                })),
            },
            stock: {
                movementCount: stockMovementResult.rows.reduce((sum, row) => sum + Number(row.movement_count), 0),
                movements: stockMovementResult.rows.map((row) => ({
                    itemType: row.item_type,
                    itemName: row.item_name,
                    netDelta: Number(row.net_delta),
                    movementCount: Number(row.movement_count),
                })),
                lowProducts: lowStockResult.rows.map(mapProduct),
            },
        },
    };
}

async function insertSaleRecord(client, sessionId, sale) {
    await client.query(`
        INSERT INTO sales_records (
            id,
            session_id,
            channel,
            created_at,
            customer_name,
            staff_name,
            payment_method,
            status,
            items,
            subtotal,
            discount,
            total,
            cash_received,
            change,
            note
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (id)
        DO UPDATE SET
            status = EXCLUDED.status,
            items = EXCLUDED.items,
            subtotal = EXCLUDED.subtotal,
            discount = EXCLUDED.discount,
            total = EXCLUDED.total,
            cash_received = EXCLUDED.cash_received,
            change = EXCLUDED.change,
            note = EXCLUDED.note
    `, [
        sale.id,
        sessionId,
        sale.channel,
        sale.createdAt || new Date(),
        sale.customerName,
        sale.staffName,
        sale.paymentMethod,
        sale.status,
        JSON.stringify(sale.items || []),
        Number(sale.subtotal || 0),
        Number(sale.discount || 0),
        Number(sale.total || 0),
        Number(sale.cashReceived || 0),
        Number(sale.change || 0),
        sale.note || null,
    ]);
}

async function getCartItems(sessionId, client = pool) {
    const result = await client.query(`
        SELECT
            id AS cart_row_id,
            product_id,
            barcode,
            name,
            price,
            quantity,
            discount,
            item_type
        FROM pos_cart_items
        WHERE session_id = $1
        ORDER BY id ASC
    `, [sessionId]);

    return result.rows.map(mapCartItem);
}

async function getCartResponse(sessionId, client = pool) {
    const items = await getCartItems(sessionId, client);
    return { session_id: sessionId, items };
}

async function ensureLotteryCartSession(sessionId, client = pool) {
    const session = await ensureAppSession(sessionId, client);
    const normalizedSessionId = session.session_id;

    await client.query(`
        INSERT INTO lottery_cart_sessions (session_id)
        VALUES ($1)
        ON CONFLICT (session_id)
        DO UPDATE SET updated_at = NOW()
    `, [normalizedSessionId]);

    return normalizedSessionId;
}

async function getLotteryCartItems(sessionId, client = pool) {
    const result = await client.query(`
        SELECT
            ticket_id,
            number,
            series,
            price,
            quantity
        FROM lottery_cart_items
        WHERE session_id = $1
        ORDER BY id ASC
    `, [sessionId]);

    return result.rows.map((item) => ({
        id: String(item.ticket_id),
        ticketId: Number(item.ticket_id),
        name: `Lottery ${item.number}`,
        barcode: item.number,
        number: item.number,
        series: item.series,
        price: Number(item.price),
        quantity: Number(item.quantity),
        discount: 0,
        item_type: 'LOTTERY',
    }));
}

async function getLotteryCartResponse(sessionId, client = pool) {
    const items = await getLotteryCartItems(sessionId, client);
    return { session_id: sessionId, items };
}

async function getGasState(sessionId, client = pool) {
    const itemsResult = await client.query(`
        SELECT id, name, operation, brand, price, stock, full_stock, empty_stock, image_url
        FROM gas_items
        WHERE active = TRUE
        ORDER BY price DESC, id ASC
    `);

    const jobsResult = await client.query(`
        SELECT
            id,
            customer_name,
            phone,
            address,
            driver,
            total,
            delivery_fee,
            returned_tank_quantity,
            empty_tank_returned,
            paid,
            status,
            created_at
        FROM gas_jobs
        WHERE session_id = $1
        ORDER BY created_at DESC
    `, [sessionId]);

    const jobIds = jobsResult.rows.map((job) => job.id);
    let jobItemsByJobId = new Map();
    if (jobIds.length > 0) {
        const jobItemsResult = await client.query(`
            SELECT job_id, name, operation, quantity, price
            FROM gas_job_items
            WHERE job_id = ANY($1::varchar[])
            ORDER BY id ASC
        `, [jobIds]);

        jobItemsByJobId = jobItemsResult.rows.reduce((map, item) => {
            const items = map.get(item.job_id) || [];
            items.push({
                name: `${item.name} ${item.operation}`,
                quantity: Number(item.quantity),
                price: Number(item.price),
            });
            map.set(item.job_id, items);
            return map;
        }, new Map());
    }

    const returnsResult = await client.query(`
        SELECT id, job_id, customer_name, phone, tank_name, borrowed_at, quantity
        FROM gas_returns
        WHERE session_id = $1 AND status = 'PENDING'
        ORDER BY borrowed_at DESC
    `, [sessionId]);

    return {
        items: itemsResult.rows.map(mapGasItem),
        jobs: jobsResult.rows.map((job) => ({
            id: job.id,
            customerName: job.customer_name,
            phone: job.phone,
            address: job.address,
            driver: job.driver,
            items: jobItemsByJobId.get(job.id) || [],
            total: Number(job.total),
            deliveryFee: Number(job.delivery_fee),
            returnedTankQuantity: Number(job.returned_tank_quantity || 0),
            emptyTankReturned: Boolean(job.empty_tank_returned),
            paid: Boolean(job.paid),
            status: job.status,
            createdAt: timeLabel(job.created_at),
        })),
        pendingReturns: returnsResult.rows.map((item) => ({
            id: item.id,
            jobId: item.job_id,
            customerName: item.customer_name,
            phone: item.phone,
            tankName: item.tank_name,
            borrowedAt: timeLabel(item.borrowed_at),
            quantity: Number(item.quantity),
        })),
    };
}

app.post('/api/auth/login', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!username || !password) {
        return res.status(400).json({ error: 'username and password are required' });
    }

    try {
        const result = await pool.query(`
            SELECT *
            FROM app_users
            WHERE username = $1 AND active = TRUE
            LIMIT 1
        `, [username]);
        const user = result.rows[0];

        if (!user || !verifyPassword(password, user)) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

        await pool.query(`
            INSERT INTO app_user_sessions (token_hash, user_id, expires_at)
            VALUES ($1, $2, $3)
        `, [sha256(token), user.id, expiresAt]);

        res.json({
            token,
            expiresAt,
            user: sanitizeUser(user),
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

app.use('/api', requireAuth);
registerGasVoiceAI(app);
registerStoreOperations(app, { pool, requireOwner, ensureOpenAppSession, adjustProductStock, logAudit });

app.get('/api/auth/me', (req, res) => {
    res.json({ user: req.user });
});

app.post('/api/auth/logout', async (req, res) => {
    const authorization = String(req.headers.authorization || '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (token) {
        await pool.query('DELETE FROM app_user_sessions WHERE token_hash = $1', [sha256(token)]);
    }
    res.json({ ok: true });
});

app.patch('/api/auth/password', async (req, res) => {
    const currentPassword = String(req.body.currentPassword || req.body.current_password || '');
    const newPassword = String(req.body.newPassword || req.body.new_password || '');

    if (!currentPassword || newPassword.length < 6 || newPassword.length > 256) {
        return res.status(400).json({ error: 'currentPassword and newPassword of 6-256 characters are required' });
    }

    const authorization = String(req.headers.authorization || '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const tokenHash = token ? sha256(token) : '';
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const before = await client.query('SELECT * FROM app_users WHERE id = $1 AND active = TRUE FOR UPDATE', [req.user.id]);
        const user = before.rows[0];
        if (!user || !verifyPassword(currentPassword, user)) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'current password is incorrect' });
        }

        const { salt, hash } = hashPassword(newPassword);
        const result = await client.query(`
            UPDATE app_users
            SET password_hash = $1,
                password_salt = $2,
                updated_at = NOW()
            WHERE id = $3
            RETURNING id, username, display_name, role, active, created_at, updated_at
        `, [hash, salt, req.user.id]);
        if (tokenHash) {
            await client.query('DELETE FROM app_user_sessions WHERE user_id = $1 AND token_hash <> $2', [req.user.id, tokenHash]);
        }
        await logAudit(client, req, 'UPDATE', 'USER_PASSWORD', req.user.id, 'change own password', sanitizeUser(user), sanitizeUser(result.rows[0]));
        await client.query('COMMIT');
        res.json({ ok: true, user: sanitizeUser(result.rows[0]) });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.get('/api/users', requireOwner, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, username, display_name, role, active, created_at, updated_at
            FROM app_users
            ORDER BY id ASC
        `);
        res.json(result.rows.map(sanitizeUser));
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/users', requireOwner, async (req, res) => {
    const username = String(req.body.username || '').trim();
    const displayName = String(req.body.displayName || req.body.display_name || '').trim();
    const password = String(req.body.password || '');
    const role = String(req.body.role || USER_ROLE).trim();

    if (!username || !displayName || password.length < 6 || password.length > 256 || !USER_ROLES.has(role)) {
        return res.status(400).json({ error: 'username, displayName, password >= 6, and valid role are required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { salt, hash } = hashPassword(password);
        const result = await client.query(`
            INSERT INTO app_users (username, display_name, password_hash, password_salt, role, active)
            VALUES ($1, $2, $3, $4, $5, TRUE)
            RETURNING id, username, display_name, role, active, created_at, updated_at
        `, [username, displayName, hash, salt, role]);
        await logAudit(client, req, 'CREATE', 'USER', result.rows[0].id, 'create user', null, sanitizeUser(result.rows[0]));
        await client.query('COMMIT');
        res.status(201).json(sanitizeUser(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ error: 'username already exists' });
        }
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.patch('/api/users/:userId', requireOwner, async (req, res) => {
    const userId = Number(req.params.userId);
    const username = req.body.username === undefined ? undefined : String(req.body.username || '').trim();
    const displayName = req.body.displayName === undefined && req.body.display_name === undefined
        ? undefined
        : String(req.body.displayName || req.body.display_name || '').trim();
    const role = req.body.role === undefined ? undefined : String(req.body.role || '').trim();
    const active = req.body.active === undefined ? undefined : Boolean(req.body.active);
    const password = req.body.password === undefined ? undefined : String(req.body.password || '');

    if (!Number.isInteger(userId)) {
        return res.status(400).json({ error: 'valid user id is required' });
    }

    if (role !== undefined && !USER_ROLES.has(role)) {
        return res.status(400).json({ error: 'valid role is required' });
    }

    if (password !== undefined && (password.length < 6 || password.length > 256)) {
        return res.status(400).json({ error: 'password must be 6-256 characters' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const before = await client.query('SELECT id, username, display_name, role, active, created_at, updated_at FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
        if (!before.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'user not found' });
        }

        const updates = [];
        const values = [userId];
        if (username !== undefined) {
            values.push(username);
            updates.push(`username = $${values.length}`);
        }
        if (displayName !== undefined) {
            values.push(displayName);
            updates.push(`display_name = $${values.length}`);
        }
        if (role !== undefined) {
            values.push(role);
            updates.push(`role = $${values.length}`);
        }
        if (active !== undefined) {
            values.push(active);
            updates.push(`active = $${values.length}`);
        }
        if (password !== undefined) {
            const { salt, hash } = hashPassword(password);
            values.push(hash);
            updates.push(`password_hash = $${values.length}`);
            values.push(salt);
            updates.push(`password_salt = $${values.length}`);
        }

        if (updates.length === 0) {
            await client.query('ROLLBACK');
            return res.json(sanitizeUser(before.rows[0]));
        }

        const result = await client.query(`
            UPDATE app_users
            SET ${updates.join(', ')}, updated_at = NOW()
            WHERE id = $1
            RETURNING id, username, display_name, role, active, created_at, updated_at
        `, values);
        if (password !== undefined) {
            // Revoke the target's old sessions. A signed-in owner resetting their
            // own password keeps only the session making this request.
            const token = String(req.headers.authorization || '').slice('Bearer '.length).trim();
            if (userId === req.user.id) {
                await client.query('DELETE FROM app_user_sessions WHERE user_id = $1 AND token_hash <> $2', [userId, sha256(token)]);
            } else {
                await client.query('DELETE FROM app_user_sessions WHERE user_id = $1', [userId]);
            }
            await logAudit(client, req, 'UPDATE', 'USER_PASSWORD', userId, 'owner reset password', sanitizeUser(before.rows[0]), sanitizeUser(result.rows[0]));
        }
        await logAudit(client, req, 'UPDATE', 'USER', userId, req.body.reason || 'update user', sanitizeUser(before.rows[0]), sanitizeUser(result.rows[0]));
        await client.query('COMMIT');
        res.json(sanitizeUser(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ error: 'username already exists' });
        }
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.delete('/api/users/:userId', requireOwner, async (req, res) => {
    const userId = Number(req.params.userId);
    if (userId === req.user.id) {
        return res.status(409).json({ error: 'cannot deactivate current owner session' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const before = await client.query('SELECT id, username, display_name, role, active, created_at, updated_at FROM app_users WHERE id = $1 FOR UPDATE', [userId]);
        if (!before.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'user not found' });
        }

        const result = await client.query(`
            UPDATE app_users
            SET active = FALSE, updated_at = NOW()
            WHERE id = $1
            RETURNING id, username, display_name, role, active, created_at, updated_at
        `, [userId]);
        await client.query('DELETE FROM app_user_sessions WHERE user_id = $1', [userId]);
        await logAudit(client, req, 'DELETE', 'USER', userId, req.body.reason || 'deactivate user', sanitizeUser(before.rows[0]), sanitizeUser(result.rows[0]));
        await client.query('COMMIT');
        res.json(sanitizeUser(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.get('/api/staff', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, name, phone, role, active
            FROM staff_members
            ORDER BY active DESC, id ASC
        `);
        res.json(result.rows.map(mapStaff));
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/staff', requireOwner, async (req, res) => {
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const role = String(req.body.role || 'staff').trim();

    if (!name) {
        return res.status(400).json({ error: 'staff name is required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const nextIdResult = await client.query(`
            SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '\\D', '', 'g'), '')::int), 0) + 1 AS next_id
            FROM staff_members
        `);
        const id = `S-${String(nextIdResult.rows[0].next_id).padStart(3, '0')}`;
        const result = await client.query(`
            INSERT INTO staff_members (id, name, phone, role, active)
            VALUES ($1, $2, $3, $4, TRUE)
            RETURNING id, name, phone, role, active
        `, [id, name, phone, role]);
        await logAudit(client, req, 'CREATE', 'STAFF', id, 'create staff', null, mapStaff(result.rows[0]));
        await client.query('COMMIT');
        res.status(201).json(mapStaff(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.patch('/api/staff/:staffId', requireOwner, async (req, res) => {
    const staffId = String(req.params.staffId || '').trim();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const before = await client.query('SELECT id, name, phone, role, active FROM staff_members WHERE id = $1 FOR UPDATE', [staffId]);
        if (!before.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'staff not found' });
        }

        const updates = [];
        const values = [staffId];
        ['name', 'phone', 'role'].forEach((field) => {
            if (req.body[field] !== undefined) {
                values.push(String(req.body[field] || '').trim());
                updates.push(`${field} = $${values.length}`);
            }
        });
        if (req.body.active !== undefined) {
            values.push(Boolean(req.body.active));
            updates.push(`active = $${values.length}`);
        }

        if (updates.length === 0) {
            await client.query('ROLLBACK');
            return res.json(mapStaff(before.rows[0]));
        }

        const result = await client.query(`
            UPDATE staff_members
            SET ${updates.join(', ')}, updated_at = NOW()
            WHERE id = $1
            RETURNING id, name, phone, role, active
        `, values);
        await logAudit(client, req, 'UPDATE', 'STAFF', staffId, req.body.reason || 'update staff', mapStaff(before.rows[0]), mapStaff(result.rows[0]));
        await client.query('COMMIT');
        res.json(mapStaff(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.delete('/api/staff/:staffId', requireOwner, async (req, res) => {
    const staffId = String(req.params.staffId || '').trim();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const before = await client.query('SELECT id, name, phone, role, active FROM staff_members WHERE id = $1 FOR UPDATE', [staffId]);
        if (!before.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'staff not found' });
        }

        const result = await client.query(`
            UPDATE staff_members
            SET active = FALSE, updated_at = NOW()
            WHERE id = $1
            RETURNING id, name, phone, role, active
        `, [staffId]);
        await logAudit(client, req, 'DELETE', 'STAFF', staffId, req.body.reason || 'deactivate staff', mapStaff(before.rows[0]), mapStaff(result.rows[0]));
        await client.query('COMMIT');
        res.json(mapStaff(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.get('/api/app-sessions/today', async (req, res) => {
    try {
        const session = await ensureAppSession(dailySessionId());
        res.json({
            ...session,
            previousClosedSession: await getPreviousClosedSession(session.business_date),
        });
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    }
});

app.get('/api/app-sessions/:sessionId', async (req, res) => {
    try {
        const session = await ensureAppSession(req.params.sessionId);
        res.json({
            ...session,
            previousClosedSession: await getPreviousClosedSession(session.business_date),
        });
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    }
});

app.get('/api/app-sessions/:sessionId/closing-summary', requireOwner, async (req, res) => {
    try {
        res.json(await getClosingSummary(req.params.sessionId));
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    }
});

app.patch('/api/app-sessions/:sessionId/closing-checks/:section', requireOwner, async (req, res) => {
    const section = String(req.params.section || '').trim().toUpperCase();
    if (!CLOSING_SECTIONS.includes(section)) {
        return res.status(400).json({ error: 'valid closing section is required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureAppSession(req.params.sessionId, client);
        if (!isOpenSessionStatus(session.status)) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: session.status === SESSION_CLOSED ? 'shop is closed' : 'shop is not open' });
        }

        const confirmed = req.body.confirmed !== false;
        const note = String(req.body.note || '').trim();
        await client.query(`
            INSERT INTO app_session_closing_checks (session_id, section, confirmed, confirmed_by, confirmed_at, note, updated_at)
            VALUES ($1, $2, $3, $4, CASE WHEN $3 THEN NOW() ELSE NULL END, $5, NOW())
            ON CONFLICT (session_id, section)
            DO UPDATE SET
                confirmed = EXCLUDED.confirmed,
                confirmed_by = EXCLUDED.confirmed_by,
                confirmed_at = EXCLUDED.confirmed_at,
                note = EXCLUDED.note,
                updated_at = NOW()
        `, [session.session_id, section, confirmed, req.user.id, note || null]);
        await logAudit(client, req, confirmed ? 'CONFIRM' : 'UNCONFIRM', 'CLOSING_CHECK', `${session.session_id}:${section}`, note || 'closing check', null, { section, confirmed });
        const summary = await getClosingSummary(session.session_id, client);
        await client.query('COMMIT');
        res.json(summary);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    } finally {
        client.release();
    }
});

app.post('/api/app-sessions/:sessionId/open', requireOwner, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureAppSession(req.params.sessionId, client);
        if (session.status === SESSION_CLOSED) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'closed session cannot be reopened' });
        }

        const result = await client.query(`
            UPDATE app_sessions
            SET status = $1,
                opened_at = COALESCE(opened_at, NOW()),
                opened_by = COALESCE(opened_by, $2),
                updated_at = NOW()
            WHERE session_id = $3
            RETURNING session_id, business_date, status, opened_at, opened_by, closed_at, closed_by
        `, [SESSION_OPEN, req.user.id, session.session_id]);
        const openedSession = mapAppSession(result.rows[0]);
        const previousClosedSession = await getPreviousClosedSession(openedSession.business_date, client);
        await logAudit(client, req, 'OPEN', 'APP_SESSION', session.session_id, req.body.reason || 'open shop', session, openedSession);
        await client.query('COMMIT');
        res.json({
            ...openedSession,
            previousClosedSession,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    } finally {
        client.release();
    }
});

app.post('/api/app-sessions/:sessionId/reopen', requireOwner, async (req, res) => {
    const reason = String(req.body.reason || '').trim();
    if (!reason) {
        return res.status(400).json({ error: 'reopen reason is required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureAppSession(req.params.sessionId, client);
        if (session.status !== SESSION_CLOSED) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'only closed sessions can be reopened' });
        }

        await client.query('DELETE FROM app_session_closing_checks WHERE session_id = $1', [session.session_id]);
        const result = await client.query(`
            UPDATE app_sessions
            SET status = $1,
                closed_at = NULL,
                closed_by = NULL,
                updated_at = NOW()
            WHERE session_id = $2
            RETURNING session_id, business_date, status, opened_at, opened_by, closed_at, closed_by
        `, [SESSION_OPEN, session.session_id]);
        const reopenedSession = mapAppSession(result.rows[0]);
        await logAudit(client, req, 'REOPEN', 'APP_SESSION', session.session_id, reason, session, reopenedSession);
        const summary = await getClosingSummary(session.session_id, client);
        await client.query('COMMIT');
        res.json(summary);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    } finally {
        client.release();
    }
});

app.post('/api/app-sessions/:sessionId/close', requireOwner, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureAppSession(req.params.sessionId, client);
        if (session.status === SESSION_CLOSED) {
            await client.query('ROLLBACK');
            return res.json(await getClosingSummary(session.session_id));
        }
        if (!isOpenSessionStatus(session.status)) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'shop is not open' });
        }

        const pending = await client.query(`SELECT COUNT(*)::int AS count FROM sales_records WHERE session_id = $1 AND channel = 'LOTTERY' AND status = $2`, [session.session_id, LOTTERY_PENDING]);
        if (pending.rows[0].count > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'มีรายการหวยรอเจ้าของร้านยืนยัน กรุณายืนยันหรือยกเลิกก่อนปิดร้าน' });
        }
        const summary = await getClosingSummary(session.session_id, client);
        if (!summary.checks.every((check) => check.confirmed)) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'all closing sections must be confirmed', summary });
        }

        const result = await client.query(`
            UPDATE app_sessions
            SET status = $1,
                closed_at = NOW(),
                closed_by = $2,
                updated_at = NOW()
            WHERE session_id = $3
            RETURNING session_id, business_date, status, opened_at, opened_by, closed_at, closed_by
        `, [SESSION_CLOSED, req.user.id, session.session_id]);
        await logAudit(client, req, 'CLOSE', 'APP_SESSION', session.session_id, req.body.reason || 'close shop', session, mapAppSession(result.rows[0]));
        const closedSummary = await getClosingSummary(session.session_id, client);
        await client.query('COMMIT');
        res.json(closedSummary);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    } finally {
        client.release();
    }
});

app.get('/api/analytics/sales', async (req, res) => {
    try {
        const range = resolveAnalyticsRange(req.query);
        const [sales, transfers] = await Promise.all([
            getCombinedSaleRecordsByDateRange(range.startDate, range.endDate),
            transferRecordsByDateRange(pool, range.startDate, range.endDate),
        ]);
        res.json({
            ...range,
            sales,
            transfers,
        });
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    }
});

app.get('/api/app-sessions/:sessionId/sales', async (req, res) => {
    try {
        const session = await ensureAppSession(req.params.sessionId);
        res.json(await getCombinedSaleRecords(session.session_id));
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    }
});

app.post('/api/app-sessions/:sessionId/sales', requireOwner, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureOpenAppSession(req.params.sessionId, client);
        const sale = req.body;

        if (!sale?.id || !sale?.channel || !Array.isArray(sale.items)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: "sale id, channel, and items are required" });
        }

        await insertSaleRecord(client, session.session_id, {
            ...sale,
            createdAt: sale.createdAt ? new Date(sale.createdAt) : new Date(),
        });
        await client.query('COMMIT');
        res.status(201).json((await getSalesRecords(session.session_id))[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
    } finally {
        client.release();
    }
});

app.patch('/api/app-sessions/:sessionId/sales/:saleId', requireOwner, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureAppSession(req.params.sessionId, client);
        const before = await client.query('SELECT * FROM sales_records WHERE id = $1 AND session_id = $2 FOR UPDATE', [
            req.params.saleId,
            session.session_id,
        ]);
        if (!before.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'sale not found' });
        }

        if (before.rows[0].channel === 'LOTTERY' && before.rows[0].status === LOTTERY_PENDING) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'กรุณาใช้ปุ่มยืนยันรายการหวยเพื่อยืนยันการรับเงิน' });
        }
        const updates = [];
        const values = [req.params.saleId, session.session_id];
        const stringFields = [
            ['customerName', 'customer_name'],
            ['staffName', 'staff_name'],
            ['paymentMethod', 'payment_method'],
            ['status', 'status'],
            ['note', 'note'],
        ];
        stringFields.forEach(([bodyField, column]) => {
            if (req.body[bodyField] !== undefined) {
                values.push(String(req.body[bodyField] || '').trim());
                updates.push(`${column} = $${values.length}`);
            }
        });
        const numberFields = [
            ['subtotal', 'subtotal'],
            ['discount', 'discount'],
            ['total', 'total'],
            ['cashReceived', 'cash_received'],
            ['change', 'change'],
        ];
        numberFields.forEach(([bodyField, column]) => {
            if (req.body[bodyField] !== undefined) {
                values.push(Number(req.body[bodyField]));
                updates.push(`${column} = $${values.length}`);
            }
        });

        if (updates.length === 0) {
            await client.query('ROLLBACK');
            return res.json(mapSaleRecord(before.rows[0]));
        }

        const result = await client.query(`
            UPDATE sales_records
            SET ${updates.join(', ')}, updated_at = NOW()
            WHERE id = $1 AND session_id = $2
            RETURNING *
        `, values);
        await logAudit(client, req, 'UPDATE', 'SALE', req.params.saleId, req.body.reason || 'update sale', mapSaleRecord(before.rows[0]), mapSaleRecord(result.rows[0]));
        await client.query('COMMIT');
        res.json(mapSaleRecord(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Database error' });
    } finally {
        client.release();
    }
});

app.post('/api/app-sessions/:sessionId/sales/:saleId/cancel', requireOwner, async (req, res) => {
    const reason = String(req.body.reason || '').trim();
    if (!reason) {
        return res.status(400).json({ error: 'cancel reason is required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureAppSession(req.params.sessionId, client);
        const saleResult = await client.query('SELECT * FROM sales_records WHERE id = $1 AND session_id = $2 FOR UPDATE', [
            req.params.saleId,
            session.session_id,
        ]);
        const sale = saleResult.rows[0];
        if (!sale) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'sale not found' });
        }
        if (sale.status === 'CANCELLED') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'sale already cancelled' });
        }

        const sourceType = sale.channel === 'GAS'
            ? 'GAS_JOB'
            : sale.channel === 'LOTTERY'
                ? 'LOTTERY_SALE'
                : 'POS_SALE';
        const reversedCount = await reverseInventoryMovements(client, req, sourceType, req.params.saleId, reason);

        if (reversedCount === 0 && Array.isArray(sale.items)) {
            for (const item of sale.items) {
                const quantity = Math.max(0, Math.floor(Number(item.quantity || 0)));
                if (quantity <= 0) {
                    continue;
                }

                if (sale.channel === 'POS') {
                    const productId = Number(item.productId || item.id || 0);
                    if (Number.isInteger(productId) && productId > 0) {
                        await adjustProductStock(client, req, productId, quantity, reason, 'POS_SALE_REVERSAL', req.params.saleId);
                    } else if (item.barcode) {
                        const productResult = await client.query('SELECT id FROM products WHERE barcode = $1 LIMIT 1', [item.barcode]);
                        if (productResult.rows[0]) {
                            await adjustProductStock(client, req, productResult.rows[0].id, quantity, reason, 'POS_SALE_REVERSAL', req.params.saleId);
                        }
                    }
                }

                if (sale.channel === 'LOTTERY') {
                    const ticketId = Number(item.ticketId || item.id || 0);
                    if (Number.isInteger(ticketId) && ticketId > 0) {
                        await adjustLotteryStock(client, req, ticketId, quantity, reason, 'LOTTERY_SALE_REVERSAL', req.params.saleId);
                    } else if (item.number || item.barcode) {
                        const ticketResult = await client.query('SELECT id FROM lottery_tickets WHERE number = $1 LIMIT 1', [
                            item.number || item.barcode,
                        ]);
                        if (ticketResult.rows[0]) {
                            await adjustLotteryStock(client, req, ticketResult.rows[0].id, quantity, reason, 'LOTTERY_SALE_REVERSAL', req.params.saleId);
                        }
                    }
                }
            }
        }

        if (sale.channel === 'GAS') {
            await client.query(`
                UPDATE gas_jobs
                SET status = 'CANCELLED',
                    cancel_reason = $1,
                    cancelled_at = NOW(),
                    updated_at = NOW()
                WHERE id = $2 AND session_id = $3
            `, [reason, req.params.saleId, session.session_id]);
            await client.query(`
                UPDATE gas_returns
                SET status = 'CANCELLED', cancelled_at = NOW()
                WHERE job_id = $1 AND session_id = $2 AND status = 'PENDING'
            `, [req.params.saleId, session.session_id]);
        }

        const result = await client.query(`
            UPDATE sales_records
            SET status = 'CANCELLED',
                cancel_reason = $1,
                cancelled_at = NOW(),
                cancelled_by = $2,
                updated_at = NOW()
            WHERE id = $3 AND session_id = $4
            RETURNING *
        `, [reason, req.user.id, req.params.saleId, session.session_id]);
        await logAudit(client, req, 'CANCEL', 'SALE', req.params.saleId, reason, mapSaleRecord(sale), mapSaleRecord(result.rows[0]));
        await client.query('COMMIT');
        res.json(mapSaleRecord(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Database error' });
    } finally {
        client.release();
    }
});

app.get('/api/app-sessions/:sessionId/receipt-print-requests', async (req, res) => {
    try {
        const session = await ensureAppSession(req.params.sessionId);
        const status = String(req.query.status || 'PENDING').toUpperCase();
        const result = await pool.query(`
            SELECT id, session_id, sale_id, channel, receipt_json, status, requested_by, requested_at
            FROM receipt_print_requests
            WHERE session_id = $1 AND status = $2
            ORDER BY requested_at ASC
        `, [session.session_id, status]);
        res.json(result.rows.map(mapPrintRequest));
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    }
});

app.patch('/api/app-sessions/:sessionId/receipt-print-requests/:requestId', async (req, res) => {
    try {
        const session = await ensureAppSession(req.params.sessionId);
        const status = String(req.body.status || '').toUpperCase();
        if (!['PENDING', 'PRINTING', 'PRINTED', 'FAILED'].includes(status)) {
            return res.status(400).json({ error: "valid status is required" });
        }

        const result = await pool.query(`
            UPDATE receipt_print_requests
            SET status = $1::varchar,
                printed_at = CASE WHEN $1::varchar = 'PRINTED' THEN NOW() ELSE printed_at END
            WHERE id = $2 AND session_id = $3
            RETURNING id, session_id, sale_id, channel, receipt_json, status, requested_by, requested_at
        `, [status, Number(req.params.requestId), session.session_id]);

        if (!result.rows[0]) {
            return res.status(404).json({ error: "print request not found" });
        }

        res.json(mapPrintRequest(result.rows[0]));
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    }
});

app.post('/api/app-sessions/:sessionId/pos/checkout', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureAppSession(req.params.sessionId, client);
        const sessionId = await ensureCartSession(session.session_id, client);
        const cart = await getCartItems(sessionId, client);

        if (cart.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: "cart is empty" });
        }

        const billDiscount = Math.max(0, Number(req.body.billDiscount || 0));
        const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity - item.discount, 0);
        const total = Math.max(0, subtotal - billDiscount);
        const createdAt = new Date();
        const saleId = createSaleId('POS', createdAt);
        const paymentMethod = req.body.paymentMethod || 'เงินสด';
        const cashReceived = paymentMethod === 'เงินสด' ? Number(req.body.cashReceived || 0) : total;

        if (paymentMethod === 'เงินสด' && cashReceived < total) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: "cash received is not enough", shortage: total - cashReceived });
        }

        for (const item of cart) {
            if (item.item_type !== 'PRODUCT') {
                continue;
            }

            const productResult = await client.query('SELECT stock FROM products WHERE id = $1 FOR UPDATE', [Number(item.id)]);
            const stock = Number(productResult.rows[0]?.stock || 0);
            if (stock < item.quantity) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: "Stock is not enough", item });
            }

            await adjustProductStock(
                client,
                req,
                Number(item.id),
                -item.quantity,
                `POS checkout ${sessionId}`,
                'POS_SALE',
                saleId,
            );
        }

        const receipt = {
            id: saleId,
            createdAt: createdAt.toISOString(),
            cashierName: req.body.cashierName || 'ไม่ระบุพนักงาน',
            customerName: req.body.customerName || 'ลูกค้าทั่วไป',
            paymentMethod,
            items: cart,
            subtotal,
            billDiscount,
            total,
            cashReceived,
            change: Math.max(0, cashReceived - total),
        };
        const sale = {
            id: receipt.id,
            channel: 'POS',
            createdAt,
            customerName: receipt.customerName,
            staffName: receipt.cashierName,
            paymentMethod,
            status: 'สำเร็จ',
            items: cart.map((item) => ({
                id: item.id,
                productId: item.id,
                name: item.name,
                barcode: item.barcode,
                quantity: item.quantity,
                price: item.price,
                discount: item.discount,
            })),
            subtotal,
            discount: billDiscount,
            total,
            cashReceived,
            change: receipt.change,
            note: req.body.note || 'ขายหน้าร้าน',
        };

        await insertSaleRecord(client, sessionId, sale);
        await client.query('DELETE FROM pos_cart_items WHERE session_id = $1', [sessionId]);
        const printResult = await client.query(`
            INSERT INTO receipt_print_requests (session_id, sale_id, channel, receipt_json, requested_by)
            VALUES ($1, $2, 'POS', $3::jsonb, $4)
            RETURNING id, session_id, sale_id, channel, receipt_json, status, requested_by, requested_at
        `, [sessionId, receipt.id, JSON.stringify(receipt), req.body.requestedBy || 'web']);

        await client.query('COMMIT');
        res.status(201).json({
            receipt,
            sale: mapSaleRecord({
                id: sale.id,
                channel: sale.channel,
                created_at: sale.createdAt,
                customer_name: sale.customerName,
                staff_name: sale.staffName,
                payment_method: sale.paymentMethod,
                status: sale.status,
                items: sale.items,
                subtotal: sale.subtotal,
                discount: sale.discount,
                total: sale.total,
                cash_received: sale.cashReceived,
                change: sale.change,
                note: sale.note,
            }),
            printRequest: mapPrintRequest(printResult.rows[0]),
            cart: await getCartResponse(sessionId, client),
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    } finally {
        client.release();
    }
});

app.get('/api/product-registration-requests', requireOwner, async (req, res) => {
    try {
        const status = String(req.query.status || 'PENDING').trim().toUpperCase();
        const normalizedStatus = ['PENDING', 'ACCEPTED', 'REJECTED', 'ALL'].includes(status) ? status : 'PENDING';
        const result = await pool.query(`
            SELECT
                r.*,
                COALESCE(requester.display_name, requester.username, 'system') AS requested_by_name,
                COALESCE(reviewer.display_name, reviewer.username, '') AS reviewed_by_name
            FROM product_registration_requests r
            LEFT JOIN app_users requester ON requester.id = r.requested_by
            LEFT JOIN app_users reviewer ON reviewer.id = r.reviewed_by
            WHERE ($1 = 'ALL' OR r.status = $1)
            ORDER BY
                CASE WHEN r.status = 'PENDING' THEN 0 ELSE 1 END,
                r.created_at ASC
            LIMIT 80
        `, [normalizedStatus]);
        res.json(result.rows.map(mapProductRegistrationRequest));
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
    }
});

app.post('/api/product-registration-requests', async (req, res) => {
    const draft = productDraftFromBody(req.body);

    if (!validateProductDraft(draft)) {
        return res.status(400).json({ error: "barcode, name, and price are required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const existingProduct = await client.query('SELECT id FROM products WHERE barcode = $1 AND active = TRUE LIMIT 1', [draft.barcode]);
        if (existingProduct.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: "Barcode already exists" });
        }

        const existingPending = await client.query(`
            SELECT
                r.*,
                COALESCE(requester.display_name, requester.username, 'system') AS requested_by_name,
                COALESCE(reviewer.display_name, reviewer.username, '') AS reviewed_by_name
            FROM product_registration_requests r
            LEFT JOIN app_users requester ON requester.id = r.requested_by
            LEFT JOIN app_users reviewer ON reviewer.id = r.reviewed_by
            WHERE r.barcode = $1 AND r.status = 'PENDING'
            LIMIT 1
        `, [draft.barcode]);
        if (existingPending.rows[0]) {
            await client.query('COMMIT');
            return res.status(202).json(mapProductRegistrationRequest(existingPending.rows[0]));
        }

        const insertResult = await client.query(`
            INSERT INTO product_registration_requests (
                barcode,
                name,
                price,
                cost,
                stock,
                category,
                min_stock,
                unit,
                requested_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
        `, [
            draft.barcode,
            draft.name,
            draft.price,
            draft.cost,
            draft.stock,
            draft.category,
            draft.minStock,
            draft.unit,
            req.user.id,
        ]);

        await logAudit(client, req, 'REQUEST_CREATE', 'PRODUCT_REGISTRATION_REQUEST', insertResult.rows[0].id, req.body.reason || 'request product registration', null, draft);

        const requestResult = await client.query(`
            SELECT
                r.*,
                COALESCE(requester.display_name, requester.username, 'system') AS requested_by_name,
                COALESCE(reviewer.display_name, reviewer.username, '') AS reviewed_by_name
            FROM product_registration_requests r
            LEFT JOIN app_users requester ON requester.id = r.requested_by
            LEFT JOIN app_users reviewer ON reviewer.id = r.reviewed_by
            WHERE r.id = $1
        `, [insertResult.rows[0].id]);
        await client.query('COMMIT');
        res.status(202).json(mapProductRegistrationRequest(requestResult.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ error: "Product registration request already exists" });
        }
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
    } finally {
        client.release();
    }
});

app.patch('/api/product-registration-requests/:requestId', requireOwner, async (req, res) => {
    const requestId = Number(req.params.requestId);
    const action = String(req.body.action || '').trim().toUpperCase();
    const reviewReason = String(req.body.reason || '').trim();

    if (!Number.isInteger(requestId) || requestId <= 0) {
        return res.status(400).json({ error: "valid request id is required" });
    }
    if (!['ACCEPT', 'REJECT'].includes(action)) {
        return res.status(400).json({ error: "action must be ACCEPT or REJECT" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const beforeResult = await client.query(`
            SELECT *
            FROM product_registration_requests
            WHERE id = $1
            FOR UPDATE
        `, [requestId]);
        const request = beforeResult.rows[0];
        if (!request) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "product registration request not found" });
        }
        if (request.status !== 'PENDING') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: "product registration request is already reviewed" });
        }

        let product = null;
        if (action === 'ACCEPT') {
            product = await createProductFromDraft(
                client,
                req,
                productDraftFromBody(request),
                reviewReason || `accept product request ${requestId}`,
            );
        }

        await client.query(`
            UPDATE product_registration_requests
            SET status = $1,
                reviewed_by = $2,
                accepted_product_id = $3,
                review_reason = $4,
                reviewed_at = NOW(),
                updated_at = NOW()
            WHERE id = $5
        `, [
            action === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
            req.user.id,
            product?.id || null,
            reviewReason,
            requestId,
        ]);

        const requestResult = await client.query(`
            SELECT
                r.*,
                COALESCE(requester.display_name, requester.username, 'system') AS requested_by_name,
                COALESCE(reviewer.display_name, reviewer.username, '') AS reviewed_by_name
            FROM product_registration_requests r
            LEFT JOIN app_users requester ON requester.id = r.requested_by
            LEFT JOIN app_users reviewer ON reviewer.id = r.reviewed_by
            WHERE r.id = $1
        `, [requestId]);
        await logAudit(client, req, action === 'ACCEPT' ? 'ACCEPT' : 'REJECT', 'PRODUCT_REGISTRATION_REQUEST', requestId, reviewReason || action.toLowerCase(), mapProductRegistrationRequest(request), mapProductRegistrationRequest(requestResult.rows[0]));
        await client.query('COMMIT');
        res.json({
            request: mapProductRegistrationRequest(requestResult.rows[0]),
            product: product ? mapProduct(product) : null,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.statusCode === 409 || err.code === '23505') {
            return res.status(409).json({ error: err.message || "Barcode already exists" });
        }
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
    } finally {
        client.release();
    }
});

app.get('/api/products', async (req, res) => {
    try {
        const includeInactive = req.user?.role === OWNER_ROLE && String(req.query.includeInactive || '') === 'true';
        const result = await pool.query(`
            SELECT
                p.id,
                p.barcode,
                p.name,
                p.price,
                p.cost,
                p.stock,
                p.category_id,
                p.min_stock,
                p.unit,
                p.active,
                c.name AS category
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE ($1::boolean = TRUE OR p.active = TRUE)
            ORDER BY p.id ASC
        `, [includeInactive]);
        res.json(result.rows.map(mapProduct));
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
    }
});

app.post('/api/products', requireOwner, async (req, res) => {
    const draft = productDraftFromBody(req.body);

    if (!validateProductDraft(draft, true)) {
        return res.status(400).json({ error: "name and a valid price are required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const product = await createProductFromDraft(client, req, draft, req.body.reason || 'upsert product');
        await client.query('COMMIT');
        res.status(201).json(mapProduct(product));
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505' || err.statusCode === 409) {
            return res.status(409).json({ error: "Barcode already exists" });
        }
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
    } finally {
        client.release();
    }
});

app.patch('/api/products/:productId', requireOwner, async (req, res) => {
    const productId = Number(req.params.productId);
    if (!Number.isInteger(productId)) {
        return res.status(400).json({ error: "valid product id is required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const before = await client.query(`
            SELECT p.*, c.name AS category
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.id = $1
            FOR UPDATE OF p
        `, [productId]);
        if (!before.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "product not found" });
        }

        const updates = [];
        const values = [productId];
        ['barcode', 'name', 'unit'].forEach((field) => {
            if (req.body[field] !== undefined) {
                const value = String(req.body[field] || '').trim();
                values.push(field === 'barcode' ? value || null : value);
                updates.push(`${field} = $${values.length}`);
            }
        });
        ['price', 'cost'].forEach((field) => {
            if (req.body[field] !== undefined) {
                values.push(Number(req.body[field]));
                updates.push(`${field} = $${values.length}`);
            }
        });
        if (req.body.minStock !== undefined || req.body.min_stock !== undefined) {
            values.push(Math.max(0, Math.floor(Number(req.body.minStock || req.body.min_stock || 0))));
            updates.push(`min_stock = $${values.length}`);
        }
        if (req.body.category !== undefined) {
            const categoryName = String(req.body.category || '').trim();
            const categoryId = categoryName ? await ensureCategory(categoryName, client) : null;
            values.push(categoryId);
            updates.push(`category_id = $${values.length}`);
        }
        if (req.body.active !== undefined) {
            values.push(Boolean(req.body.active));
            updates.push(`active = $${values.length}`);
        }

        if (updates.length === 0) {
            await client.query('ROLLBACK');
            return res.json(mapProduct(before.rows[0]));
        }

        const result = await client.query(`
            UPDATE products
            SET ${updates.join(', ')}, updated_at = NOW()
            WHERE id = $1
            RETURNING id, barcode, name, price, cost, stock, category_id, min_stock, unit, active
        `, values);
        const categoryResult = await client.query('SELECT name FROM categories WHERE id = $1', [result.rows[0].category_id]);
        const product = { ...result.rows[0], category: categoryResult.rows[0]?.name ?? null };
        await logAudit(client, req, 'UPDATE', 'PRODUCT', productId, req.body.reason || 'update product', mapProduct(before.rows[0]), mapProduct(product));
        await client.query('COMMIT');
        res.json(mapProduct(product));
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ error: "Barcode already exists" });
        }
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
    } finally {
        client.release();
    }
});

app.delete('/api/products/:productId', requireOwner, async (req, res) => {
    const productId = Number(req.params.productId);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const before = await client.query(`
            SELECT p.*, c.name AS category
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.id = $1
            FOR UPDATE OF p
        `, [productId]);
        if (!before.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "product not found" });
        }

        const result = await client.query(`
            UPDATE products
            SET active = FALSE, updated_at = NOW()
            WHERE id = $1
            RETURNING id, barcode, name, price, cost, stock, category_id, min_stock, unit, active
        `, [productId]);
        const product = { ...result.rows[0], category: before.rows[0].category };
        await logAudit(client, req, 'DELETE', 'PRODUCT', productId, req.body.reason || 'deactivate product', mapProduct(before.rows[0]), mapProduct(product));
        await client.query('COMMIT');
        res.json(mapProduct(product));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
    } finally {
        client.release();
    }
});

app.patch('/api/products/:productId/stock', requireOwner, async (req, res) => {
    const productId = Number(req.params.productId);
    const delta = Number(req.body.delta);
    const reason = String(req.body.reason || '').trim();

    if (!Number.isInteger(productId) || !Number.isFinite(delta) || delta === 0 || !reason) {
        return res.status(400).json({ error: "product id, non-zero delta, and reason are required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await adjustProductStock(client, req, productId, Math.floor(delta), reason, 'STOCK_ADJUST', productId);
        const result = await client.query(`
            SELECT p.*, c.name AS category
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.id = $1
        `, [productId]);
        await logAudit(client, req, 'STOCK_ADJUST', 'PRODUCT', productId, reason, null, mapProduct(result.rows[0]));
        await client.query('COMMIT');
        res.json(mapProduct(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    } finally {
        client.release();
    }
});

app.get('/api/stock/movements', requireOwner, async (req, res) => {
    try {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
            ? String(req.query.date)
            : null;
        const params = [];
        let where = '';
        if (date) {
            params.push(date);
            params.push(addUtcDays(date, 1));
            where = `
                WHERE m.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Bangkok')
                  AND m.created_at < ($2::date::timestamp AT TIME ZONE 'Asia/Bangkok')
            `;
        }

        const result = await pool.query(`
            SELECT
                m.*,
                COALESCE(u.display_name, 'system') AS actor_name
            FROM inventory_movements m
            LEFT JOIN app_users u ON u.id = m.created_by
            ${where}
            ORDER BY m.created_at DESC
            LIMIT 300
        `, params);
        res.json(result.rows.map(mapInventoryMovement));
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
    }
});

app.get('/api/gas/items', async (req, res) => {
    try {
        const includeInactive = req.user?.role === OWNER_ROLE && String(req.query.includeInactive || '') === 'true';
        const result = await pool.query(`
            SELECT id, name, operation, brand, price, stock, full_stock, empty_stock, image_url, active
            FROM gas_items
            WHERE ($1::boolean = TRUE OR active = TRUE)
            ORDER BY price DESC, id ASC
        `, [includeInactive]);
        res.json(result.rows.map(mapGasItem));
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
    }
});

app.post('/api/gas/items', requireOwner, async (req, res) => {
    const id = String(req.body.id || '').trim().toUpperCase();
    const name = String(req.body.name || '').trim();
    const brand = String(req.body.brand || '').trim();
    if (!['สยาม', 'ปตท'].includes(brand)) {
        return res.status(400).json({ error: 'กรุณาเลือกยี่ห้อสยามหรือ ปตท.' });
    }
    const operation = String(req.body.operation || '').trim();
    const price = Number(req.body.price);
    const fullStock = Math.max(0, Math.floor(Number(req.body.fullStock ?? req.body.full_stock ?? req.body.stock ?? 0)));
    const emptyStock = Math.max(0, Math.floor(Number(req.body.emptyStock ?? req.body.empty_stock ?? 0)));
    const imageUrl = String(req.body.imageUrl || req.body.image_url || '').trim();

    if (!id || !name || !operation || !Number.isFinite(price) || price <= 0 || !Number.isFinite(fullStock) || !Number.isFinite(emptyStock)) {
        return res.status(400).json({ error: 'id, name, operation, price, full stock, and empty stock are required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const before = await client.query(`
            SELECT id, name, operation, brand, price, stock, full_stock, empty_stock, image_url, active
            FROM gas_items
            WHERE id = $1
            FOR UPDATE
        `, [id]);
        const previousFullStock = Number(before.rows[0]?.full_stock ?? before.rows[0]?.stock ?? 0);
        const previousEmptyStock = Number(before.rows[0]?.empty_stock ?? 0);
        const fullStockDelta = fullStock - previousFullStock;
        const emptyStockDelta = emptyStock - previousEmptyStock;
        const result = await client.query(`
            INSERT INTO gas_items (id, name, operation, price, stock, full_stock, empty_stock, image_url, active, brand)
            VALUES ($1, $2, $3, $4, $5, $5, $6, $7, TRUE, $8)
            ON CONFLICT (id)
            DO UPDATE SET
                name = EXCLUDED.name,
                brand = EXCLUDED.brand,
                operation = EXCLUDED.operation,
                price = EXCLUDED.price,
                stock = EXCLUDED.stock,
                full_stock = EXCLUDED.full_stock,
                empty_stock = EXCLUDED.empty_stock,
                image_url = EXCLUDED.image_url,
                active = TRUE,
                updated_at = NOW()
            RETURNING id, name, operation, brand, price, stock, full_stock, empty_stock, image_url, active
        `, [id, name, operation, price, fullStock, emptyStock, imageUrl || null, brand]);
        if (fullStockDelta !== 0) {
            await recordInventoryMovement(client, req, {
                itemType: 'GAS',
                itemId: result.rows[0].id,
                itemName: `${result.rows[0].name} ${result.rows[0].operation}`,
                delta: fullStockDelta,
                reason: req.body.reason || 'initial gas stock',
                sourceType: 'GAS_ITEM_CREATE',
                sourceId: result.rows[0].id,
                stockKind: 'FULL',
            });
        }
        if (emptyStockDelta !== 0) {
            await recordInventoryMovement(client, req, {
                itemType: 'GAS',
                itemId: result.rows[0].id,
                itemName: `${result.rows[0].name} ${result.rows[0].operation}`,
                delta: emptyStockDelta,
                reason: req.body.reason || 'initial gas empty stock',
                sourceType: 'GAS_ITEM_CREATE',
                sourceId: result.rows[0].id,
                stockKind: 'EMPTY',
            });
        }
        await logAudit(client, req, 'UPSERT', 'GAS_ITEM', id, req.body.reason || 'upsert gas item', before.rows[0] ? mapGasItem(before.rows[0]) : null, mapGasItem(result.rows[0]));
        await client.query('COMMIT');
        res.status(201).json(mapGasItem(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
    } finally {
        client.release();
    }
});

app.patch('/api/gas/items/:itemId', requireOwner, async (req, res) => {
    const itemId = String(req.params.itemId || '').trim();
    if (req.body.brand !== undefined && !['สยาม', 'ปตท'].includes(req.body.brand)) {
        return res.status(400).json({ error: 'กรุณาเลือกยี่ห้อสยามหรือ ปตท.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const before = await client.query('SELECT id, name, operation, brand, price, stock, full_stock, empty_stock, image_url, active FROM gas_items WHERE id = $1 FOR UPDATE', [itemId]);
        if (!before.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'gas item not found' });
        }

        const updates = [];
        const values = [itemId];
        ['name', 'operation', 'brand'].forEach((field) => {
            if (req.body[field] !== undefined) {
                values.push(String(req.body[field] || '').trim());
                updates.push(`${field} = $${values.length}`);
            }
        });
        if (req.body.imageUrl !== undefined || req.body.image_url !== undefined) {
            values.push(String(req.body.imageUrl || req.body.image_url || '').trim() || null);
            updates.push(`image_url = $${values.length}`);
        }
        if (req.body.price !== undefined) {
            values.push(Number(req.body.price));
            updates.push(`price = $${values.length}`);
        }
        if (req.body.active !== undefined) {
            values.push(Boolean(req.body.active));
            updates.push(`active = $${values.length}`);
        }

        if (updates.length === 0) {
            await client.query('ROLLBACK');
            return res.json(mapGasItem(before.rows[0]));
        }

        const result = await client.query(`
            UPDATE gas_items
            SET ${updates.join(', ')}, updated_at = NOW()
            WHERE id = $1
            RETURNING id, name, operation, brand, price, stock, full_stock, empty_stock, image_url, active
        `, values);
        await logAudit(client, req, 'UPDATE', 'GAS_ITEM', itemId, req.body.reason || 'update gas item', mapGasItem(before.rows[0]), mapGasItem(result.rows[0]));
        await client.query('COMMIT');
        res.json(mapGasItem(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
    } finally {
        client.release();
    }
});

app.delete('/api/gas/items/:itemId', requireOwner, async (req, res) => {
    const itemId = String(req.params.itemId || '').trim();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const before = await client.query('SELECT id, name, operation, brand, price, stock, full_stock, empty_stock, image_url, active FROM gas_items WHERE id = $1 FOR UPDATE', [itemId]);
        if (!before.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'gas item not found' });
        }

        const result = await client.query(`
            UPDATE gas_items
            SET active = FALSE, updated_at = NOW()
            WHERE id = $1
            RETURNING id, name, operation, brand, price, stock, full_stock, empty_stock, image_url, active
        `, [itemId]);
        await logAudit(client, req, 'DELETE', 'GAS_ITEM', itemId, req.body.reason || 'deactivate gas item', mapGasItem(before.rows[0]), mapGasItem(result.rows[0]));
        await client.query('COMMIT');
        res.json(mapGasItem(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
    } finally {
        client.release();
    }
});

app.patch('/api/gas/items/:itemId/stock', requireOwner, async (req, res) => {
    const itemId = String(req.params.itemId || '').trim();
    const delta = Number(req.body.delta);
    const reason = String(req.body.reason || '').trim();
    const stockKind = normalizeGasStockKind(req.body.stockKind || req.body.stock_kind || 'FULL');

    if (!itemId || !Number.isFinite(delta) || delta === 0 || !reason) {
        return res.status(400).json({ error: 'gas item id, non-zero delta, and reason are required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await adjustGasStock(client, req, itemId, Math.floor(delta), reason, 'STOCK_ADJUST', itemId, null, stockKind);
        const result = await client.query(`
            SELECT id, name, operation, brand, price, stock, full_stock, empty_stock, image_url, active
            FROM gas_items
            WHERE id = $1
        `, [itemId]);
        await logAudit(client, req, 'STOCK_ADJUST', 'GAS_ITEM', itemId, reason, null, mapGasItem(result.rows[0]));
        await client.query('COMMIT');
        res.json(mapGasItem(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Database error' });
    } finally {
        client.release();
    }
});

app.get('/api/app-sessions/:sessionId/gas', async (req, res) => {
    try {
        const session = await ensureAppSession(req.params.sessionId);
        res.json(await getGasState(session.session_id));
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    }
});

app.post('/api/app-sessions/:sessionId/gas/jobs', async (req, res) => {
    const brand = String(req.body.brand || '').trim();
    if (!['สยาม', 'ปตท'].includes(brand)) {
        return res.status(400).json({ error: 'กรุณาเลือกยี่ห้อแก๊ส' });
    }
    const orderItems = Array.isArray(req.body.items) ? req.body.items : [];
    const customerName = String(req.body.customerName || '').trim();
    const phone = String(req.body.phone || '').trim();
    const address = String(req.body.address || '').trim();
    const driver = String(req.body.driver || '').trim() || 'ยังไม่ระบุ';
    const deliveryFee = Math.max(0, Number(req.body.deliveryFee || 0));
    const paid = req.user.role === OWNER_ROLE ? req.body.paid !== false : false;
    const requestedReturnedTankQuantity = req.user.role === OWNER_ROLE
        ? Math.max(0, Math.floor(Number(req.body.emptyTankReturnQuantity || 0)))
        : 0;

    if (orderItems.length === 0) {
        return res.status(400).json({ error: "gas items are required" });
    }

    if (!customerName || !address) {
        return res.status(400).json({ error: "customer name and address are required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureOpenAppSession(req.params.sessionId, client);
        const createdAt = new Date();
        const jobId = `${createSaleId('GAS', createdAt)}-${crypto.randomBytes(6).toString('hex')}`;
        const normalizedItems = [];
        let subtotal = 0;
        let totalTankQuantity = 0;

        for (const orderItem of orderItems) {
            const gasItemId = String(orderItem.id || '').trim();
            const quantity = Math.max(0, Math.floor(Number(orderItem.quantity || 0)));
            if (!gasItemId || quantity <= 0) {
                continue;
            }

            const itemResult = await client.query(`
                SELECT id, name, operation, brand, price, stock, full_stock, empty_stock
                FROM gas_items
                WHERE id = $1 AND active = TRUE
                FOR UPDATE
            `, [gasItemId]);
            const item = itemResult.rows[0];
            if (!item) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: "gas item not found", gasItemId });
            }

            if (item.brand !== brand) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'ยี่ห้อถังไม่ตรงกับยี่ห้อที่เลือก', gasItemId });
            }

            const availableFullStock = Number(item.full_stock ?? item.stock ?? 0);
            if (availableFullStock < quantity) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: "Gas stock is not enough", item });
            }

            await adjustGasStock(client, req, gasItemId, -quantity, `Gas job ${jobId}`, 'GAS_JOB', jobId, null, 'FULL');
            normalizedItems.push({
                id: item.id,
                name: item.name.includes(brand) ? item.name : `${brand} ${item.name}`,
                operation: item.operation,
                quantity,
                price: Number(item.price),
            });
            subtotal += Number(item.price) * quantity;
            totalTankQuantity += quantity;
        }

        if (normalizedItems.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: "valid gas item quantity is required" });
        }

        const returnedTankQuantity = Math.min(totalTankQuantity, requestedReturnedTankQuantity);
        const emptyTankReturned = returnedTankQuantity >= totalTankQuantity;
        const total = subtotal + deliveryFee;
        const jobStatus = paid && emptyTankReturned ? 'เสร็จแล้ว' : 'กำลังดำเนินการ';

        await client.query(`
            INSERT INTO gas_jobs (
                id,
                session_id,
                customer_name,
                phone,
                address,
                driver,
                total,
                delivery_fee,
                returned_tank_quantity,
                empty_tank_returned,
                paid,
                status,
                created_at,
                completed_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, CASE WHEN $12::text = 'เสร็จแล้ว' THEN $13::timestamptz ELSE NULL END)
        `, [
            jobId,
            session.session_id,
            customerName,
            phone,
            address,
            driver,
            total,
            deliveryFee,
            returnedTankQuantity,
            emptyTankReturned,
            paid,
            jobStatus,
            createdAt,
        ]);

        let remainingReturnedTanks = returnedTankQuantity;
        for (const item of normalizedItems) {
            await client.query(`
                INSERT INTO gas_job_items (job_id, gas_item_id, name, operation, quantity, price)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [jobId, item.id, item.name, item.operation, item.quantity, item.price]);

            const returnedForItem = Math.min(item.quantity, remainingReturnedTanks);
            remainingReturnedTanks -= returnedForItem;
            const pendingQuantity = item.quantity - returnedForItem;

            if (returnedForItem > 0) {
                await adjustGasStock(client, req, item.id, returnedForItem, `Gas tank returned on ${jobId}`, 'GAS_JOB', jobId, null, 'EMPTY');
            }

            if (pendingQuantity > 0) {
                await client.query(`
                    INSERT INTO gas_returns (
                        id,
                        session_id,
                        job_id,
                        gas_item_id,
                        customer_name,
                        phone,
                        tank_name,
                        borrowed_at,
                        quantity,
                        status
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING')
                `, [
                    `${jobId}-TANK-${item.id}`,
                    session.session_id,
                    jobId,
                    item.id,
                    customerName,
                    phone,
                    item.name,
                    createdAt,
                    pendingQuantity,
                ]);
            }
        }

        const sale = {
            id: jobId,
            channel: 'GAS',
            createdAt,
            customerName,
            staffName: driver,
            paymentMethod: 'เงินสด',
            status: paid ? 'สำเร็จ' : 'กำลังดำเนินการ',
            items: normalizedItems.map((item) => ({
                name: `${item.name} ${item.operation}`,
                quantity: item.quantity,
                price: item.price,
                discount: 0,
            })),
            subtotal,
            discount: 0,
            total,
            cashReceived: paid ? total : 0,
            change: 0,
            note: `${phone} | ${address} | ค่าส่ง ${deliveryFee} | คืนถังเปล่า ${returnedTankQuantity}/${totalTankQuantity} | ${paid ? 'จ่ายแล้ว' : 'ค้างจ่าย'}`,
        };
        await insertSaleRecord(client, session.session_id, sale);

        await client.query('COMMIT');
        res.status(201).json({
            state: await getGasState(session.session_id),
            sale,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    } finally {
        client.release();
    }
});

app.patch('/api/app-sessions/:sessionId/gas/jobs/:jobId', requireOwner, async (req, res) => {
    const rawStatus = String(req.body.status || '').trim().toUpperCase();
    const status = rawStatus === 'DONE' || rawStatus === 'COMPLETED'
        ? 'เสร็จแล้ว'
        : String(req.body.status || '').trim();
    if (!['กำลังดำเนินการ', 'เสร็จแล้ว'].includes(status)) {
        return res.status(400).json({ error: "valid gas job status is required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureAppSession(req.params.sessionId, client);
        const result = await client.query(`
            UPDATE gas_jobs
            SET paid = CASE WHEN $1::text = 'เสร็จแล้ว' THEN TRUE ELSE paid END,
                status = CASE
                    WHEN $1::text = 'เสร็จแล้ว' AND empty_tank_returned = TRUE THEN 'เสร็จแล้ว'
                    ELSE $1::text
                END,
                completed_at = CASE WHEN $1::text = 'เสร็จแล้ว' AND empty_tank_returned = TRUE THEN NOW() ELSE completed_at END
            WHERE id = $2 AND session_id = $3
            RETURNING id, status
        `, [status, req.params.jobId, session.session_id]);

        const updatedJob = result.rows[0];
        if (!updatedJob) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "gas job not found" });
        }

        await client.query('UPDATE sales_records SET status = $1 WHERE id = $2 AND session_id = $3', [
            updatedJob.status === 'เสร็จแล้ว' ? 'สำเร็จ' : updatedJob.status,
            req.params.jobId,
            session.session_id,
        ]);

        await client.query('COMMIT');
        res.json(await getGasState(session.session_id));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    } finally {
        client.release();
    }
});

app.patch('/api/app-sessions/:sessionId/gas/returns/:returnId', requireOwner, async (req, res) => {
    const requestedQuantity = Math.floor(Number(req.body.quantity || 0));

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureAppSession(req.params.sessionId, client);
        const returnResult = await client.query(`
            SELECT job_id, gas_item_id, quantity
            FROM gas_returns
            WHERE id = $1 AND session_id = $2 AND status = 'PENDING'
            FOR UPDATE
        `, [req.params.returnId, session.session_id]);
        const returnItem = returnResult.rows[0];

        if (!returnItem) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "pending gas return not found" });
        }

        const currentQuantity = Number(returnItem.quantity);
        const returnedQuantity = requestedQuantity > 0
            ? Math.min(currentQuantity, requestedQuantity)
            : currentQuantity;

        if (returnedQuantity <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: "return quantity is required" });
        }

        if (returnedQuantity >= currentQuantity) {
            await client.query(`
                UPDATE gas_returns
                SET status = 'RETURNED',
                    returned_at = NOW(),
                    returned_quantity = returned_quantity + $3
                WHERE id = $1 AND session_id = $2
            `, [req.params.returnId, session.session_id, returnedQuantity]);
        } else {
            await client.query(`
                UPDATE gas_returns
                SET quantity = quantity - $1,
                    returned_quantity = returned_quantity + $1
                WHERE id = $2 AND session_id = $3
            `, [returnedQuantity, req.params.returnId, session.session_id]);
        }

        if (returnItem.gas_item_id) {
            await adjustGasStock(
                client,
                req,
                returnItem.gas_item_id,
                returnedQuantity,
                `Gas tank returned ${req.params.returnId}`,
                'GAS_JOB',
                returnItem.job_id || req.params.returnId,
                null,
                'EMPTY',
            );
        }

        if (returnItem.job_id) {
            await client.query(`
                UPDATE gas_jobs
                SET returned_tank_quantity = returned_tank_quantity + $1
                WHERE id = $2 AND session_id = $3
            `, [returnedQuantity, returnItem.job_id, session.session_id]);

            const pendingReturnResult = await client.query(`
                SELECT COUNT(*)::int AS count
                FROM gas_returns
                WHERE job_id = $1 AND status = 'PENDING'
            `, [returnItem.job_id]);

            if (pendingReturnResult.rows[0].count === 0) {
                const completedJobResult = await client.query(`
                    UPDATE gas_jobs
                    SET empty_tank_returned = TRUE,
                        status = CASE WHEN paid = TRUE THEN 'เสร็จแล้ว' ELSE status END,
                        completed_at = CASE WHEN paid = TRUE THEN NOW() ELSE completed_at END
                    WHERE id = $1 AND session_id = $2
                    RETURNING status
                `, [returnItem.job_id, session.session_id]);

                const completedJob = completedJobResult.rows[0];
                if (completedJob) {
                    await client.query('UPDATE sales_records SET status = $1 WHERE id = $2 AND session_id = $3', [
                        completedJob.status === 'เสร็จแล้ว' ? 'สำเร็จ' : completedJob.status,
                        returnItem.job_id,
                        session.session_id,
                    ]);
                }
            }
        }

        await client.query('COMMIT');
        res.json(await getGasState(session.session_id));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    } finally {
        client.release();
    }
});

app.post('/api/app-sessions/:sessionId/gas/jobs/:jobId/cancel', requireOwner, async (req, res) => {
    const reason = String(req.body.reason || '').trim();
    if (!reason) {
        return res.status(400).json({ error: 'cancel reason is required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureAppSession(req.params.sessionId, client);
        const before = await client.query(`
            SELECT *
            FROM gas_jobs
            WHERE id = $1 AND session_id = $2
            FOR UPDATE
        `, [req.params.jobId, session.session_id]);
        const job = before.rows[0];
        if (!job) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'gas job not found' });
        }
        if (job.status === 'CANCELLED') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'gas job already cancelled' });
        }

        await reverseInventoryMovements(client, req, 'GAS_JOB', req.params.jobId, reason);
        const result = await client.query(`
            UPDATE gas_jobs
            SET status = 'CANCELLED',
                cancel_reason = $1,
                cancelled_at = NOW(),
                updated_at = NOW()
            WHERE id = $2 AND session_id = $3
            RETURNING *
        `, [reason, req.params.jobId, session.session_id]);
        await client.query(`
            UPDATE gas_returns
            SET status = 'CANCELLED', cancelled_at = NOW()
            WHERE job_id = $1 AND session_id = $2 AND status = 'PENDING'
        `, [req.params.jobId, session.session_id]);
        await client.query(`
            UPDATE sales_records
            SET status = 'CANCELLED',
                cancel_reason = $1,
                cancelled_at = NOW(),
                cancelled_by = $2,
                updated_at = NOW()
            WHERE id = $3 AND session_id = $4
        `, [reason, req.user.id, req.params.jobId, session.session_id]);
        await logAudit(client, req, 'CANCEL', 'GAS_JOB', req.params.jobId, reason, job, result.rows[0]);
        await client.query('COMMIT');
        res.json(await getGasState(session.session_id));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Database error' });
    } finally {
        client.release();
    }
});

app.get('/api/lottery/tickets', async (req, res) => {
    try {
        const includeInactive = req.user?.role === OWNER_ROLE && String(req.query.includeInactive || '') === 'true';
        const result = await pool.query(`
            SELECT id, number, series, price, remaining, stock_reference, active
            FROM lottery_tickets
            WHERE ($1::boolean = TRUE OR active = TRUE)
            ORDER BY number ASC
        `, [includeInactive]);
        res.json(result.rows.map(mapLotteryTicket));
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/lottery/books', requireOwner, async (req, res) => {
    const { quantity, price } = req.body;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000 || !Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ error: 'invalid quantity or price' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let suffix = 0; suffix < 100; suffix++) {
            const number = String(suffix).padStart(2, '0');
            const ticket = await client.query(`
                INSERT INTO lottery_tickets (number, series, price, remaining, active)
                VALUES ($1, 'เลขท้าย', $2, 0, TRUE)
                ON CONFLICT (number) DO UPDATE SET price = EXCLUDED.price, active = TRUE
                RETURNING id`, [number, price]);
            const id = ticket.rows[0].id;
            await adjustLotteryStock(client, req, id, quantity, 'รับสลากเข้าเล่ม', 'LOTTERY_STOCK', id);
        }
        await client.query('COMMIT');
        res.status(201).json({ total: quantity * 100 });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'could not receive lottery book' });
    } finally { client.release(); }
});

app.post('/api/lottery/tickets', requireOwner, async (req, res) => {
    const number = String(req.body.number || '').replace(/\D/g, '').slice(0, 6);
    const series = String(req.body.series || 'Manual').trim() || 'Manual';
    const quantity = Math.floor(Number(req.body.quantity ?? req.body.remaining ?? 0));
    const price = Number(req.body.price);
    const reason = String(req.body.reason || 'manual lottery stock').trim();

    if (!/^\d{6}$/.test(number) || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ error: 'number, quantity, and price are required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const ticketResult = await client.query(`
            INSERT INTO lottery_tickets (number, series, price, remaining, active)
            VALUES ($1, $2, $3, 0, TRUE)
            ON CONFLICT (number)
            DO UPDATE SET series = EXCLUDED.series, price = EXCLUDED.price, active = TRUE, updated_at = NOW()
            RETURNING id, number, series, price, remaining, stock_reference, active
        `, [number, series, price]);
        await adjustLotteryStock(client, req, ticketResult.rows[0].id, quantity, reason, 'LOTTERY_STOCK', ticketResult.rows[0].id);
        const result = await client.query('SELECT id, number, series, price, remaining, stock_reference, active FROM lottery_tickets WHERE id = $1', [ticketResult.rows[0].id]);
        await logAudit(client, req, 'UPSERT', 'LOTTERY_TICKET', ticketResult.rows[0].id, reason, null, mapLotteryTicket(result.rows[0]));
        await client.query('COMMIT');
        res.status(201).json(mapLotteryTicket(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.patch('/api/lottery/tickets/:ticketId', requireOwner, async (req, res) => {
    const ticketId = Number(req.params.ticketId);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const before = await client.query('SELECT id, number, series, price, remaining, stock_reference, active FROM lottery_tickets WHERE id = $1 FOR UPDATE', [ticketId]);
        if (!before.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'lottery ticket not found' });
        }

        const updates = [];
        const values = [ticketId];
        if (req.body.number !== undefined) {
            values.push(String(req.body.number || '').replace(/\D/g, '').slice(0, 6));
            updates.push(`number = $${values.length}`);
        }
        if (req.body.series !== undefined) {
            values.push(String(req.body.series || 'Manual').trim() || 'Manual');
            updates.push(`series = $${values.length}`);
        }
        if (req.body.price !== undefined) {
            values.push(Number(req.body.price));
            updates.push(`price = $${values.length}`);
        }
        if (req.body.active !== undefined) {
            values.push(Boolean(req.body.active));
            updates.push(`active = $${values.length}`);
        }
        if (Number.isFinite(Number(req.body.delta)) && Number(req.body.delta) !== 0) {
            await adjustLotteryStock(
                client,
                req,
                ticketId,
                Math.floor(Number(req.body.delta)),
                String(req.body.reason || 'lottery stock adjustment'),
                'LOTTERY_STOCK_ADJUST',
                ticketId,
            );
        }

        if (updates.length > 0) {
            await client.query(`
                UPDATE lottery_tickets
                SET ${updates.join(', ')}, updated_at = NOW()
                WHERE id = $1
            `, values);
        }

        const result = await client.query('SELECT id, number, series, price, remaining, stock_reference, active FROM lottery_tickets WHERE id = $1', [ticketId]);
        await logAudit(client, req, 'UPDATE', 'LOTTERY_TICKET', ticketId, req.body.reason || 'update lottery ticket', mapLotteryTicket(before.rows[0]), mapLotteryTicket(result.rows[0]));
        await client.query('COMMIT');
        res.json(mapLotteryTicket(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(409).json({ error: 'lottery number already exists' });
        }
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.delete('/api/lottery/tickets/:ticketId', requireOwner, async (req, res) => {
    const ticketId = Number(req.params.ticketId);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const before = await client.query('SELECT id, number, series, price, remaining, stock_reference, active FROM lottery_tickets WHERE id = $1 FOR UPDATE', [ticketId]);
        if (!before.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'lottery ticket not found' });
        }

        const result = await client.query(`
            UPDATE lottery_tickets
            SET active = FALSE, updated_at = NOW()
            WHERE id = $1
            RETURNING id, number, series, price, remaining, stock_reference, active
        `, [ticketId]);
        await logAudit(client, req, 'DELETE', 'LOTTERY_TICKET', ticketId, req.body.reason || 'deactivate lottery ticket', mapLotteryTicket(before.rows[0]), mapLotteryTicket(result.rows[0]));
        await client.query('COMMIT');
        res.json(mapLotteryTicket(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.get('/api/lottery-sessions/:sessionId/cart', async (req, res) => {
    try {
        const sessionId = await ensureLotteryCartSession(req.params.sessionId);
        res.json(await getLotteryCartResponse(sessionId));
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Database error' });
    }
});

app.post('/api/lottery-sessions/:sessionId/cart/items', async (req, res) => {
    const number = String(req.body.number || '').replace(/\D/g, '').slice(0, 6);
    if (!/^(?:\d{2}|\d{6})$/.test(number)) {
        return res.status(400).json({ error: 'valid lottery number is required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureOpenAppSession(req.params.sessionId, client);
        const sessionId = await ensureLotteryCartSession(session.session_id, client);
        const ticketResult = await client.query(`
            SELECT id, number, series, price, remaining
            FROM lottery_tickets
            WHERE number = $1 AND active = TRUE
            FOR UPDATE
        `, [number]);
        const ticket = ticketResult.rows[0];
        if (!ticket) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'lottery ticket not found' });
        }

        const existingResult = await client.query('SELECT quantity FROM lottery_cart_items WHERE session_id = $1 AND ticket_id = $2', [
            sessionId,
            ticket.id,
        ]);
        const currentQuantity = Number(existingResult.rows[0]?.quantity || 0);
        if (currentQuantity >= Number(ticket.remaining || 0)) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Lottery stock is not enough', ticket: mapLotteryTicket(ticket) });
        }

        await client.query(`
            INSERT INTO lottery_cart_items (session_id, ticket_id, number, series, price, quantity)
            VALUES ($1, $2, $3, $4, $5, 1)
            ON CONFLICT (session_id, ticket_id)
            DO UPDATE SET quantity = lottery_cart_items.quantity + 1, price = EXCLUDED.price, updated_at = NOW()
        `, [sessionId, ticket.id, ticket.number, ticket.series, ticket.price]);
        await client.query('UPDATE lottery_cart_sessions SET updated_at = NOW() WHERE session_id = $1', [sessionId]);
        const response = await getLotteryCartResponse(sessionId, client);
        await client.query('COMMIT');
        res.status(201).json(response);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Database error' });
    } finally {
        client.release();
    }
});

app.patch('/api/lottery-sessions/:sessionId/cart/items/:ticketId', async (req, res) => {
    const ticketId = Number(req.params.ticketId);
    const quantity = Math.floor(Number(req.body.quantity));
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureOpenAppSession(req.params.sessionId, client);
        const sessionId = await ensureLotteryCartSession(session.session_id, client);
        if (!Number.isInteger(ticketId)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'valid ticket id is required' });
        }

        if (Number.isFinite(quantity) && quantity <= 0) {
            await client.query('DELETE FROM lottery_cart_items WHERE session_id = $1 AND ticket_id = $2', [sessionId, ticketId]);
        } else if (Number.isFinite(quantity)) {
            const ticketResult = await client.query('SELECT remaining FROM lottery_tickets WHERE id = $1', [ticketId]);
            const remaining = Number(ticketResult.rows[0]?.remaining || 0);
            if (quantity > remaining) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Lottery stock is not enough', remaining });
            }
            await client.query(`
                UPDATE lottery_cart_items
                SET quantity = $1, updated_at = NOW()
                WHERE session_id = $2 AND ticket_id = $3
            `, [quantity, sessionId, ticketId]);
        }

        await client.query('UPDATE lottery_cart_sessions SET updated_at = NOW() WHERE session_id = $1', [sessionId]);
        const response = await getLotteryCartResponse(sessionId, client);
        await client.query('COMMIT');
        res.json(response);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Database error' });
    } finally {
        client.release();
    }
});

app.delete('/api/lottery-sessions/:sessionId/cart/items/:ticketId', async (req, res) => {
    try {
        const session = await ensureOpenAppSession(req.params.sessionId);
        const sessionId = await ensureLotteryCartSession(session.session_id);
        await pool.query('DELETE FROM lottery_cart_items WHERE session_id = $1 AND ticket_id = $2', [sessionId, Number(req.params.ticketId)]);
        await pool.query('UPDATE lottery_cart_sessions SET updated_at = NOW() WHERE session_id = $1', [sessionId]);
        res.json(await getLotteryCartResponse(sessionId));
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Database error' });
    }
});

app.delete('/api/lottery-sessions/:sessionId/cart', async (req, res) => {
    try {
        const session = await ensureOpenAppSession(req.params.sessionId);
        const sessionId = await ensureLotteryCartSession(session.session_id);
        await pool.query('DELETE FROM lottery_cart_items WHERE session_id = $1', [sessionId]);
        await pool.query('UPDATE lottery_cart_sessions SET updated_at = NOW() WHERE session_id = $1', [sessionId]);
        res.json(await getLotteryCartResponse(sessionId));
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Database error' });
    }
});

app.post('/api/app-sessions/:sessionId/lottery/:saleId/confirm', requireOwner, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureOpenAppSession(req.params.sessionId, client);
        const { rows: [sale] } = await client.query(
            "SELECT * FROM sales_records WHERE id = $1 AND session_id = $2 AND channel = 'LOTTERY' FOR UPDATE",
            [req.params.saleId, session.session_id]);
        if (!sale) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบรายการหวย' }); }
        if (sale.status !== LOTTERY_PENDING) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'รายการนี้ไม่ได้รอการยืนยันแล้ว' }); }
        const received = sale.payment_method === 'PromptPay' ? Number(sale.total) : Number(req.body.cashReceived);
        if (!Number.isFinite(received) || received < Number(sale.total) || received > 9999999999.99) {
            await client.query('ROLLBACK'); return res.status(400).json({ error: 'เงินที่ตรวจรับจริงต้องไม่น้อยกว่ายอดรายการ' });
        }
        const { rows: [result] } = await client.query(`UPDATE sales_records SET status = 'completed',
            cash_received = $1, change = $1 - total, confirmed_by = $2, confirmed_by_name = $3,
            confirmed_at = NOW(), updated_at = NOW() WHERE id = $4 RETURNING *`,
            [received, req.user.id, req.user.displayName || req.user.username, sale.id]);
        await client.query("DELETE FROM app_session_closing_checks WHERE session_id = $1 AND section = 'LOTTERY'", [session.session_id]);
        await logAudit(client, req, 'CONFIRM_PAYMENT', 'LOTTERY_SALE', sale.id, 'owner verified lottery payment', mapSaleRecord(sale), mapSaleRecord(result));
        await client.query('COMMIT');
        res.json(mapSaleRecord(result));
    } catch (error) {
        await client.query('ROLLBACK'); res.status(error.statusCode || 500).json({ error: error.message || 'Database error' });
    } finally { client.release(); }
});

app.post('/api/app-sessions/:sessionId/lottery/checkout', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureOpenAppSession(req.params.sessionId, client);
        const sessionId = await ensureLotteryCartSession(session.session_id, client);
        const cart = await getLotteryCartItems(sessionId, client);
        if (cart.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'lottery cart is empty' });
        }

        const paymentMethod = req.body.paymentMethod === 'PromptPay' ? 'PromptPay' : 'เงินสด';
        const confirmed = req.user.role === OWNER_ROLE;
        const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
        const cashReceived = paymentMethod === 'PromptPay' ? subtotal : Number(req.body.cashReceived || 0);
        if (!Number.isFinite(cashReceived) || cashReceived < subtotal) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'cash received is not enough', shortage: subtotal - cashReceived });
        }

        const createdAt = new Date();
        const saleId = `${createSaleId('LOTTERY', createdAt)}-${crypto.randomBytes(6).toString('hex')}`;
        for (const item of cart) {
            const ticketResult = await client.query('SELECT remaining FROM lottery_tickets WHERE id = $1 FOR UPDATE', [Number(item.id)]);
            const remaining = Number(ticketResult.rows[0]?.remaining || 0);
            if (remaining < item.quantity) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Lottery stock is not enough', item });
            }
            await adjustLotteryStock(client, req, Number(item.id), -item.quantity, `Lottery sale ${saleId}`, 'LOTTERY_SALE', saleId);
        }

        const sale = {
            id: saleId,
            channel: 'LOTTERY',
            createdAt,
            customerName: req.body.customerName || 'walk-in',
            staffName: req.user.role === OWNER_ROLE ? (req.body.cashierName || req.user.displayName || req.user.username) : (req.user.displayName || req.user.username),
            paymentMethod,
            status: confirmed ? 'completed' : LOTTERY_PENDING,
            items: cart.map((item) => ({
                id: item.id,
                ticketId: item.id,
                number: item.number,
                name: item.name,
                barcode: item.number,
                quantity: item.quantity,
                price: item.price,
                discount: 0,
            })),
            subtotal,
            discount: 0,
            total: subtotal,
            cashReceived: confirmed ? cashReceived : 0,
            change: confirmed ? Math.max(0, cashReceived - subtotal) : 0,
            note: req.body.note || 'lottery sale',
        };

        await insertSaleRecord(client, sessionId, sale);
        await client.query(`UPDATE sales_records SET submitted_by = $1, submitted_by_name = $2,
            reported_cash_received = $3, confirmed_by = $4, confirmed_by_name = $5, confirmed_at = $6
            WHERE id = $7`, [req.user.id, req.user.displayName || req.user.username, cashReceived,
            confirmed ? req.user.id : null, confirmed ? (req.user.displayName || req.user.username) : null,
            confirmed ? createdAt : null, saleId]);
        await client.query("DELETE FROM app_session_closing_checks WHERE session_id = $1 AND section = 'LOTTERY'", [sessionId]);
        await client.query('DELETE FROM lottery_cart_items WHERE session_id = $1', [sessionId]);
        await client.query('UPDATE lottery_cart_sessions SET updated_at = NOW() WHERE session_id = $1', [sessionId]);
        await logAudit(client, req, 'CHECKOUT', 'LOTTERY_SALE', saleId, 'lottery checkout', null, sale);
        await client.query('COMMIT');
        res.status(201).json({
            sale: mapSaleRecord((await client.query('SELECT * FROM sales_records WHERE id = $1', [saleId])).rows[0]),
            cart: await getLotteryCartResponse(sessionId, client),
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Database error' });
    } finally {
        client.release();
    }
});

app.get('/api/app-sessions/:sessionId/topups', async (req, res) => {
    try {
        const session = await ensureAppSession(req.params.sessionId);
        const includeCancelled = req.user?.role === OWNER_ROLE && String(req.query.includeCancelled || '') === 'true';
        const result = await pool.query(`
            SELECT *
            FROM mobile_topup_orders
            WHERE session_id = $1
              AND ($2::boolean = TRUE OR status <> 'CANCELLED')
            ORDER BY created_at DESC
        `, [session.session_id, includeCancelled]);
        res.json(result.rows.map(mapTopupOrder));
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Database error' });
    }
});

app.post('/api/app-sessions/:sessionId/topups', async (req, res) => {
    const provider = String(req.body.provider || '').trim().toUpperCase();
    const phone = String(req.body.phone || '').replace(/\D/g, '');
    const amount = Number(req.body.amount);

    if (!['AIS', 'TRUE', 'DTAC'].includes(provider) || !/^0\d{9}$/.test(phone) || !Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'provider, phone, and amount are required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureOpenAppSession(req.params.sessionId, client);
        const createdAt = new Date();
        const id = createTopupId(createdAt);
        const result = await client.query(`
            INSERT INTO mobile_topup_orders (
                id,
                session_id,
                provider,
                phone,
                amount,
                topped_up,
                paid,
                status,
                created_by,
                created_at
            )
            VALUES ($1, $2, $3, $4, $5, FALSE, FALSE, 'ACTIVE', $6, $7)
            RETURNING *
        `, [id, session.session_id, provider, phone, amount, req.user.id, createdAt]);
        await logAudit(client, req, 'CREATE', 'TOPUP', id, 'create topup order', null, mapTopupOrder(result.rows[0]));
        await client.query('COMMIT');
        res.status(201).json(mapTopupOrder(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.patch('/api/app-sessions/:sessionId/topups/:orderId', requireOwner, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureAppSession(req.params.sessionId, client);
        const before = await client.query(`
            SELECT *
            FROM mobile_topup_orders
            WHERE id = $1 AND session_id = $2
            FOR UPDATE
        `, [req.params.orderId, session.session_id]);
        if (!before.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'topup order not found' });
        }
        if (before.rows[0].status === 'CANCELLED') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'topup order is cancelled' });
        }

        const updates = [];
        const values = [req.params.orderId, session.session_id];
        if (req.body.provider !== undefined) {
            const provider = String(req.body.provider || '').trim().toUpperCase();
            if (!['AIS', 'TRUE', 'DTAC'].includes(provider)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'valid provider is required' });
            }
            values.push(provider);
            updates.push(`provider = $${values.length}`);
        }
        if (req.body.phone !== undefined) {
            values.push(String(req.body.phone || '').replace(/\D/g, ''));
            updates.push(`phone = $${values.length}`);
        }
        if (req.body.amount !== undefined) {
            values.push(Number(req.body.amount));
            updates.push(`amount = $${values.length}`);
        }
        if (req.body.toppedUp !== undefined || req.body.topped_up !== undefined) {
            values.push(Boolean(req.body.toppedUp ?? req.body.topped_up));
            updates.push(`topped_up = $${values.length}`);
        }
        if (req.body.paid !== undefined) {
            values.push(Boolean(req.body.paid));
            updates.push(`paid = $${values.length}`);
        }

        if (updates.length === 0) {
            await client.query('ROLLBACK');
            return res.json(mapTopupOrder(before.rows[0]));
        }

        const result = await client.query(`
            UPDATE mobile_topup_orders
            SET ${updates.join(', ')}, updated_at = NOW()
            WHERE id = $1 AND session_id = $2
            RETURNING *
        `, values);
        await logAudit(client, req, 'UPDATE', 'TOPUP', req.params.orderId, req.body.reason || 'update topup order', mapTopupOrder(before.rows[0]), mapTopupOrder(result.rows[0]));
        await client.query('COMMIT');
        res.json(mapTopupOrder(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Database error' });
    } finally {
        client.release();
    }
});

app.delete('/api/app-sessions/:sessionId/topups/:orderId', requireOwner, async (req, res) => {
    const reason = String(req.body.reason || req.query.reason || '').trim();
    if (!reason) {
        return res.status(400).json({ error: 'cancel reason is required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureAppSession(req.params.sessionId, client);
        const before = await client.query(`
            SELECT *
            FROM mobile_topup_orders
            WHERE id = $1 AND session_id = $2
            FOR UPDATE
        `, [req.params.orderId, session.session_id]);
        if (!before.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'topup order not found' });
        }
        if (before.rows[0].status === 'CANCELLED') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'topup order already cancelled' });
        }

        const result = await client.query(`
            UPDATE mobile_topup_orders
            SET status = 'CANCELLED',
                cancel_reason = $1,
                cancelled_by = $2,
                cancelled_at = NOW(),
                updated_at = NOW()
            WHERE id = $3 AND session_id = $4
            RETURNING *
        `, [reason, req.user.id, req.params.orderId, session.session_id]);
        await logAudit(client, req, 'CANCEL', 'TOPUP', req.params.orderId, reason, mapTopupOrder(before.rows[0]), mapTopupOrder(result.rows[0]));
        await client.query('COMMIT');
        res.json(mapTopupOrder(result.rows[0]));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Database error' });
    } finally {
        client.release();
    }
});

app.get('/api/pos-sessions/:sessionId/cart', async (req, res) => {
    try {
        const sessionId = await ensureCartSession(req.params.sessionId);
        res.json(await getCartResponse(sessionId));
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    }
});

app.post('/api/pos-sessions/:sessionId/cart/scan', async (req, res) => {
    const query = String(req.body.barcode || '').trim().toLowerCase();
    if (!query) {
        return res.status(400).json({ error: "barcode is required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const sessionId = await ensureCartSession(req.params.sessionId, client);
        const productResult = await client.query(`
            SELECT
                p.id,
                p.barcode,
                p.name,
                p.price,
                p.stock
            FROM products p
            WHERE p.active = TRUE AND p.price > 0
              AND (LOWER(p.barcode) = $1 OR LOWER(p.name) LIKE $2)
            ORDER BY CASE WHEN LOWER(p.barcode) = $1 THEN 0 ELSE 1 END, p.id ASC
            LIMIT 1
        `, [query, `%${query}%`]);

        const product = productResult.rows[0];
        if (!product) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Product not found", barcode: req.body.barcode });
        }

        const existingResult = await client.query(
            'SELECT quantity FROM pos_cart_items WHERE session_id = $1 AND product_id = $2',
            [sessionId, product.id],
        );
        const currentQuantity = Number(existingResult.rows[0]?.quantity || 0);
        if (currentQuantity >= Number(product.stock || 0)) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: "Stock is not enough", product });
        }

        await client.query(`
            INSERT INTO pos_cart_items (session_id, product_id, barcode, name, price, quantity, discount, item_type)
            VALUES ($1, $2, $3, $4, $5, 1, 0, 'PRODUCT')
            ON CONFLICT (session_id, product_id)
            DO UPDATE SET
                quantity = pos_cart_items.quantity + 1,
                barcode = EXCLUDED.barcode,
                name = EXCLUDED.name,
                price = EXCLUDED.price,
                updated_at = NOW()
        `, [sessionId, product.id, product.barcode ?? '', product.name, product.price]);

        await client.query('UPDATE pos_cart_sessions SET updated_at = NOW() WHERE session_id = $1', [sessionId]);
        const response = await getCartResponse(sessionId, client);
        await client.query('COMMIT');
        res.status(201).json(response);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    } finally {
        client.release();
    }
});

app.patch('/api/pos-sessions/:sessionId/cart/items/:productId', async (req, res) => {
    const quantity = Number(req.body.quantity);
    const discount = Number(req.body.discount);
    const productId = Number(req.params.productId);

    if (!Number.isInteger(productId)) {
        return res.status(400).json({ error: "product id is required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const sessionId = await ensureCartSession(req.params.sessionId, client);

        if (Number.isFinite(quantity) && quantity <= 0) {
            await client.query('DELETE FROM pos_cart_items WHERE session_id = $1 AND product_id = $2', [sessionId, productId]);
        } else {
            if (Number.isFinite(quantity)) {
                const productResult = await client.query('SELECT stock FROM products WHERE id = $1', [productId]);
                const stock = Number(productResult.rows[0]?.stock || 0);
                if (quantity > stock) {
                    await client.query('ROLLBACK');
                    return res.status(409).json({ error: "Stock is not enough", stock });
                }
            }

            const updates = [];
            const values = [sessionId, productId];

            if (Number.isFinite(quantity)) {
                values.push(Math.max(1, Math.floor(quantity)));
                updates.push(`quantity = $${values.length}`);
            }

            if (Number.isFinite(discount)) {
                values.push(Math.max(0, discount));
                updates.push(`discount = $${values.length}`);
            }

            if (updates.length > 0) {
                await client.query(`
                    UPDATE pos_cart_items
                    SET ${updates.join(', ')}, updated_at = NOW()
                    WHERE session_id = $1 AND product_id = $2
                `, values);
            }
        }

        await client.query('UPDATE pos_cart_sessions SET updated_at = NOW() WHERE session_id = $1', [sessionId]);
        const response = await getCartResponse(sessionId, client);
        await client.query('COMMIT');
        res.json(response);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    } finally {
        client.release();
    }
});

app.delete('/api/pos-sessions/:sessionId/cart/items/:productId', async (req, res) => {
    try {
        const sessionId = await ensureCartSession(req.params.sessionId);
        await pool.query('DELETE FROM pos_cart_items WHERE session_id = $1 AND product_id = $2', [
            sessionId,
            Number(req.params.productId),
        ]);
        await pool.query('UPDATE pos_cart_sessions SET updated_at = NOW() WHERE session_id = $1', [sessionId]);
        res.json(await getCartResponse(sessionId));
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    }
});

app.delete('/api/pos-sessions/:sessionId/cart', async (req, res) => {
    try {
        const sessionId = await ensureCartSession(req.params.sessionId);
        await pool.query('DELETE FROM pos_cart_items WHERE session_id = $1', [sessionId]);
        await pool.query('UPDATE pos_cart_sessions SET updated_at = NOW() WHERE session_id = $1', [sessionId]);
        res.json(await getCartResponse(sessionId));
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    }
});

app.post('/api/scan-sessions/:sessionId/events', (req, res) => {
    const sessionId = req.params.sessionId;
    const barcode = String(req.body.barcode || '').trim();

    if (!barcode) {
        return res.status(400).json({ error: "barcode is required" });
    }

    const events = scanSessions.get(sessionId) || [];
    const event = {
        id: scanEventId++,
        barcode,
        source: req.body.source || 'mobile',
        created_at: new Date().toISOString(),
    };

    events.push(event);
    scanSessions.set(sessionId, events.slice(-100));
    res.status(201).json(event);
});

app.get('/api/scan-sessions/:sessionId/events', (req, res) => {
    const sessionId = req.params.sessionId;
    const after = Number(req.query.after || 0);
    const events = scanSessions.get(sessionId) || [];
    res.json(events.filter((event) => event.id > after));
});

app.get('/health', async (_req, res) => {
    try {
        await pool.query({ text: 'SELECT 1', query_timeout: 3000 });
        res.json({ ok: true });
    } catch (error) {
        logDatabaseError('Database health check failed', error);
        res.status(503).json({ ok: false, error: 'Database unavailable' });
    }
});

async function start() {
    try {
        await initializeCartTables();
    } catch (error) {
        logDatabaseError('Could not initialize backend database', error);
        process.exitCode = 1;
        await pool.end();
        return;
    }

    const server = app.listen(port, () => {
        console.log(`Server is running on port ${port} 🚀`);
    });
    server.on('error', (error) => {
        console.error(`Could not start backend on port ${port}:`, error.message);
        process.exitCode = 1;
        void pool.end();
    });
}

void start();
