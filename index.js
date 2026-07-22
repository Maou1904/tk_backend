require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
const scanSessions = new Map();
let scanEventId = 1;
const port = Number(process.env.PORT || 5000);

const pool = new Pool(process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        user: process.env.DB_USER || process.env.PGUSER,
        host: process.env.DB_HOST || process.env.PGHOST,
        database: process.env.DB_NAME || process.env.PGDATABASE,
        password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
        port: process.env.DB_PORT || process.env.PGPORT,
    });

function dateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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

async function initializeCartTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS app_sessions (
            session_id VARCHAR(80) PRIMARY KEY,
            business_date DATE NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_gas_returns_session_status
        ON gas_returns (session_id, status, borrowed_at DESC)
    `);
}

async function ensureCategory(name, client = pool) {
    const existingCategory = await client.query('SELECT id FROM categories WHERE name = $1 LIMIT 1', [name]);
    if (existingCategory.rows[0]) {
        return existingCategory.rows[0].id;
    }

    const categoryResult = await client.query('INSERT INTO categories (name) VALUES ($1) RETURNING id', [name]);
    return categoryResult.rows[0].id;
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

    await client.query(`
        INSERT INTO app_sessions (session_id, business_date)
        VALUES ($1, $2::date)
        ON CONFLICT (session_id)
        DO UPDATE SET updated_at = NOW()
    `, [normalizedSessionId, businessDate]);

    return { session_id: normalizedSessionId, business_date: businessDate };
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
    const session = await ensureAppSession(sessionId, client);
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
        items: Array.isArray(row.items) ? row.items : [],
        subtotal: Number(row.subtotal),
        discount: Number(row.discount),
        total: Number(row.total),
        cashReceived: Number(row.cash_received),
        change: Number(row.change),
        note: row.note || undefined,
    };
}

function mapGasItem(row) {
    return {
        id: row.id,
        name: row.name,
        operation: row.operation,
        price: Number(row.price),
        stock: Number(row.stock),
        imageUrl: row.image_url || '',
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

async function getGasState(sessionId, client = pool) {
    const itemsResult = await client.query(`
        SELECT id, name, operation, price, stock, image_url
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

app.get('/api/app-sessions/today', async (req, res) => {
    try {
        const session = await ensureAppSession(dailySessionId());
        res.json(session);
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    }
});

app.get('/api/analytics/sales', async (req, res) => {
    try {
        const range = resolveAnalyticsRange(req.query);
        res.json({
            ...range,
            sales: await getSalesRecordsByDateRange(range.startDate, range.endDate),
        });
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    }
});

app.get('/api/app-sessions/:sessionId/sales', async (req, res) => {
    try {
        const session = await ensureAppSession(req.params.sessionId);
        res.json(await getSalesRecords(session.session_id));
    } catch (err) {
        console.error(err.message);
        res.status(err.statusCode || 500).json({ error: err.message || "Database error" });
    }
});

app.post('/api/app-sessions/:sessionId/sales', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureAppSession(req.params.sessionId, client);
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

            await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [item.quantity, Number(item.id)]);
        }

        const createdAt = new Date();
        const receipt = {
            id: createSaleId('POS', createdAt),
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

app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                p.id,
                p.barcode,
                p.name,
                p.price,
                p.cost,
                p.stock,
                p.category_id,
                c.name AS category
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            ORDER BY p.id ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
    }
});

app.post('/api/products', async (req, res) => {
    const { barcode, name, price, cost, stock, category } = req.body;

    if (!barcode || !name || Number(price) <= 0) {
        return res.status(400).json({ error: "barcode, name, and price are required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const existingProduct = await client.query('SELECT id FROM products WHERE barcode = $1 LIMIT 1', [barcode]);
        if (existingProduct.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: "Barcode already exists" });
        }

        let categoryId = null;

        if (category) {
            categoryId = await ensureCategory(category, client);
        }

        const productResult = await client.query(
            `
            INSERT INTO products (barcode, name, price, cost, stock, category_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, barcode, name, price, cost, stock, category_id
            `,
            [
                barcode,
                name,
                Number(price),
                Number(cost || price),
                Number(stock || 0),
                categoryId,
            ],
        );

        await client.query('COMMIT');
        res.status(201).json({ ...productResult.rows[0], category: category || null });
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

app.patch('/api/products/:productId/stock', async (req, res) => {
    const productId = Number(req.params.productId);
    const delta = Number(req.body.delta);

    if (!Number.isInteger(productId) || !Number.isFinite(delta) || delta === 0) {
        return res.status(400).json({ error: "product id and non-zero delta are required" });
    }

    try {
        const result = await pool.query(`
            UPDATE products
            SET stock = GREATEST(0, COALESCE(stock, 0) + $1)
            WHERE id = $2
            RETURNING id, barcode, name, price, cost, stock, category_id
        `, [Math.floor(delta), productId]);

        if (!result.rows[0]) {
            return res.status(404).json({ error: "product not found" });
        }

        const categoryResult = await pool.query('SELECT name FROM categories WHERE id = $1', [result.rows[0].category_id]);
        res.json({ ...result.rows[0], category: categoryResult.rows[0]?.name ?? null });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
    }
});

app.get('/api/gas/items', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, name, operation, price, stock, image_url
            FROM gas_items
            WHERE active = TRUE
            ORDER BY price DESC, id ASC
        `);
        res.json(result.rows.map(mapGasItem));
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Database error" });
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
    const orderItems = Array.isArray(req.body.items) ? req.body.items : [];
    const customerName = String(req.body.customerName || '').trim();
    const phone = String(req.body.phone || '').trim();
    const address = String(req.body.address || '').trim();
    const driver = String(req.body.driver || '').trim() || 'ยังไม่ระบุ';
    const deliveryFee = Math.max(0, Number(req.body.deliveryFee || 0));
    const paid = req.body.paid !== false;
    const requestedReturnedTankQuantity = Math.max(0, Math.floor(Number(req.body.emptyTankReturnQuantity || 0)));

    if (orderItems.length === 0) {
        return res.status(400).json({ error: "gas items are required" });
    }

    if (!customerName || !phone || !address) {
        return res.status(400).json({ error: "customer name, phone, and address are required" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const session = await ensureAppSession(req.params.sessionId, client);
        const createdAt = new Date();
        const jobId = createSaleId('GAS', createdAt);
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
                SELECT id, name, operation, price, stock
                FROM gas_items
                WHERE id = $1 AND active = TRUE
                FOR UPDATE
            `, [gasItemId]);
            const item = itemResult.rows[0];
            if (!item) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: "gas item not found", gasItemId });
            }

            if (Number(item.stock) < quantity) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: "Gas stock is not enough", item });
            }

            await client.query('UPDATE gas_items SET stock = stock - $1, updated_at = NOW() WHERE id = $2', [quantity, gasItemId]);
            normalizedItems.push({
                id: item.id,
                name: item.name,
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
                await client.query('UPDATE gas_items SET stock = stock + $1, updated_at = NOW() WHERE id = $2', [
                    returnedForItem,
                    item.id,
                ]);
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

app.patch('/api/app-sessions/:sessionId/gas/jobs/:jobId', async (req, res) => {
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

app.patch('/api/app-sessions/:sessionId/gas/returns/:returnId', async (req, res) => {
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
                SET status = 'RETURNED', returned_at = NOW()
                WHERE id = $1 AND session_id = $2
            `, [req.params.returnId, session.session_id]);
        } else {
            await client.query(`
                UPDATE gas_returns
                SET quantity = quantity - $1
                WHERE id = $2 AND session_id = $3
            `, [returnedQuantity, req.params.returnId, session.session_id]);
        }

        if (returnItem.gas_item_id) {
            await client.query('UPDATE gas_items SET stock = stock + $1, updated_at = NOW() WHERE id = $2', [
                returnedQuantity,
                returnItem.gas_item_id,
            ]);
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
            WHERE LOWER(p.barcode) = $1 OR LOWER(p.name) LIKE $2
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
        `, [sessionId, product.id, product.barcode, product.name, product.price]);

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

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

initializeCartTables()
    .catch((err) => {
        console.error('Could not initialize backend database:', err.message);
    })
    .finally(() => {
        app.listen(port, () => {
            console.log(`Server is running on port ${port} 🚀`);
        });
    });
