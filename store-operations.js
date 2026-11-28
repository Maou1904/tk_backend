async function initializeStoreOperations(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cash_transfers (
            id UUID PRIMARY KEY,
            session_id VARCHAR(80) NOT NULL REFERENCES app_sessions(session_id),
            principal BIGINT NOT NULL CHECK (principal > 0),
            fee BIGINT NOT NULL CHECK (fee >= 0),
            cash_received BIGINT NOT NULL CHECK (cash_received >= principal + fee),
            bank TEXT NOT NULL DEFAULT '',
            reference TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            created_by INTEGER NOT NULL REFERENCES app_users(id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            cancelled_at TIMESTAMPTZ,
            cancel_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS cash_transfers_session_idx ON cash_transfers (session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS cash_transfers_created_idx ON cash_transfers (created_at);
        ALTER TABLE cash_transfers ADD COLUMN IF NOT EXISTS service_type TEXT NOT NULL DEFAULT 'TRANSFER'
            CHECK (service_type IN ('TRANSFER', 'ELECTRICITY'));
        ALTER TABLE cash_transfers ADD COLUMN IF NOT EXISTS rounding BIGINT NOT NULL DEFAULT 0
            CHECK (rounding >= 0 AND rounding < 100 AND rounding <= fee AND (service_type = 'ELECTRICITY' OR rounding = 0));
        CREATE UNIQUE INDEX IF NOT EXISTS cash_transfers_bank_reference_idx
            ON cash_transfers (lower(bank), lower(reference)) WHERE service_type = 'TRANSFER' AND reference <> '' AND cancelled_at IS NULL;
        DROP INDEX IF EXISTS cash_transfers_reference_idx;
        CREATE TABLE IF NOT EXISTS transfer_settings (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
            default_fee BIGINT NOT NULL CHECK (default_fee >= 0)
        );
        ALTER TABLE transfer_settings ADD COLUMN IF NOT EXISTS electricity_fee BIGINT NOT NULL DEFAULT 0 CHECK (electricity_fee >= 0);
        ALTER TABLE transfer_settings ADD COLUMN IF NOT EXISTS gas_delivery_fee BIGINT NOT NULL DEFAULT 2000;
        ALTER TABLE transfer_settings ADD COLUMN IF NOT EXISTS topup_amount BIGINT NOT NULL DEFAULT 10000;
        CREATE TABLE IF NOT EXISTS purchase_orders (
            id UUID PRIMARY KEY,
            supplier TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT '',
            items JSONB NOT NULL,
            version INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by INTEGER NOT NULL REFERENCES app_users(id)
        );
        CREATE TABLE IF NOT EXISTS purchase_receipts (
            id UUID PRIMARY KEY,
            order_id UUID NOT NULL REFERENCES purchase_orders(id),
            version INTEGER NOT NULL,
            restock BOOLEAN NOT NULL,
            note TEXT NOT NULL DEFAULT '',
            items JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by INTEGER NOT NULL REFERENCES app_users(id),
            UNIQUE (order_id, version)
        );
        ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS location TEXT NOT NULL DEFAULT '';
        CREATE TABLE IF NOT EXISTS stock_documents (
            id UUID PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN ('ISSUE', 'COUNT')),
            destination TEXT NOT NULL DEFAULT '',
            recipient TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '',
            items JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by INTEGER NOT NULL REFERENCES app_users(id),
            settled_at TIMESTAMPTZ,
            settled_by INTEGER REFERENCES app_users(id),
            settlement_note TEXT NOT NULL DEFAULT '',
            settlement JSONB
        );
        CREATE INDEX IF NOT EXISTS stock_documents_history_idx ON stock_documents (kind, created_at DESC);
        CREATE TABLE IF NOT EXISTS warehouse_stock (
            product_id INTEGER PRIMARY KEY REFERENCES products(id),
            quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0)
        );
        CREATE TABLE IF NOT EXISTS warehouse_movements (
            id UUID PRIMARY KEY,
            product_id INTEGER NOT NULL REFERENCES products(id),
            delta INTEGER NOT NULL CHECK (delta <> 0),
            balance INTEGER NOT NULL CHECK (balance >= 0),
            note TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by INTEGER NOT NULL REFERENCES app_users(id)
        );
        CREATE INDEX IF NOT EXISTS warehouse_movements_created_idx ON warehouse_movements (created_at DESC, id DESC);
        CREATE TABLE IF NOT EXISTS tax_period_notes (
            month DATE PRIMARY KEY,
            reviewed BOOLEAN NOT NULL,
            note TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
}

function problem(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
}

function identifier(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) {
        throw problem(400, 'รหัสรายการไม่ถูกต้อง');
    }
    return value;
}

function satang(value, minimum = 0) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > 99999999999) {
        throw problem(400, 'กรุณากรอกจำนวนเงินให้ถูกต้อง');
    }
    return value;
}

function clean(value, limit = 250) {
    const result = typeof value === 'string' ? value.trim() : '';
    if (result.length > limit) throw problem(400, `ข้อความต้องไม่เกิน ${limit} ตัวอักษร`);
    return result;
}

function transfer(row) {
    return {
        id: row.id, serviceType: row.service_type || 'TRANSFER', principal: Number(row.principal), fee: Number(row.fee),
        rounding: Number(row.rounding || 0),
        cashReceived: Number(row.cash_received), change: Number(row.cash_received) - Number(row.principal) - Number(row.fee),
        bank: row.bank, reference: row.reference, note: row.note, createdAt: row.created_at,
        cancelledAt: row.cancelled_at, cancelReason: row.cancel_reason,
        staff: row.staff || '',
    };
}

async function transferClosingTotals(client, sessionId, serviceType = 'TRANSFER') {
    const { rows: [row] } = await client.query(`
        SELECT COUNT(*) AS records, COUNT(*) FILTER (WHERE cancelled_at IS NULL) AS count,
               SUM(principal) FILTER (WHERE cancelled_at IS NULL) AS principal,
               SUM(fee) FILTER (WHERE cancelled_at IS NULL) AS fee,
               SUM(rounding) FILTER (WHERE cancelled_at IS NULL) AS rounding,
               SUM(cash_received) FILTER (WHERE cancelled_at IS NULL) AS cash,
               SUM(cash_received - principal - fee) FILTER (WHERE cancelled_at IS NULL) AS change
        FROM cash_transfers WHERE session_id = $1 AND service_type = $2
    `, [sessionId, serviceType]);
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

async function transferRecordsByDateRange(client, startDate, endDate) {
    const { rows } = await client.query(`
        SELECT t.*, COALESCE(u.display_name, u.username, 'system') AS staff
        FROM cash_transfers t LEFT JOIN app_users u ON u.id = t.created_by
        WHERE t.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Bangkok')
          AND t.created_at < ($2::date::timestamp AT TIME ZONE 'Asia/Bangkok')
        ORDER BY t.created_at DESC, t.id DESC
    `, [startDate, endDate]);
    return rows.map(transfer);
}

function itemQuantities(value, key, minimum, maximum = 1000000) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
        throw problem(400, 'กรุณากรอกสินค้า 1–200 รายการ');
    }
    const result = new Map();
    for (const line of value) {
        const { productId, [key]: quantity } = line || {};
        if (!Number.isSafeInteger(productId) || productId < 1 || productId > 2147483647 ||
            !Number.isInteger(quantity) || quantity < minimum || quantity > maximum || result.has(productId)) {
            throw problem(400, 'รหัสสินค้าหรือจำนวนไม่ถูกต้อง หรือมีสินค้าซ้ำ');
        }
        result.set(productId, quantity);
    }
    return result;
}

function monthStart(month) {
    if (typeof month !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) {
        throw problem(400, 'กรุณาเลือกเดือนให้ถูกต้อง');
    }
    return `${month}-01`;
}

function registerStoreOperations(app, { pool, requireOwner, ensureOpenAppSession, adjustProductStock, logAudit }) {
    const route = (handler) => async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            if (error.constraint === 'cash_transfers_bank_reference_idx') {
                return res.status(409).json({ error: 'เลขอ้างอิงนี้มีรายการรับโอนแล้ว' });
            }
            if (!error.statusCode) console.error(error.message);
            res.status(error.statusCode || 500).json({
                error: error.statusCode ? error.message : 'ระบบบันทึกข้อมูลขัดข้อง กรุณาลองอีกครั้ง',
            });
        }
    };

    async function transaction(work) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    const readSettings = async () => {
        const { rows: [row] } = await pool.query('SELECT default_fee, electricity_fee, gas_delivery_fee, topup_amount FROM transfer_settings');
        return {
            defaultFee: Number(row?.default_fee ?? 0),
            electricityFee: Number(row?.electricity_fee ?? 0),
            gasDeliveryFee: Number(row?.gas_delivery_fee ?? 2000),
            topupAmount: Number(row?.topup_amount ?? 10000),
        };
    };

    app.get('/api/store-settings', route(async (_req, res) => {
        res.json(await readSettings());
    }));

    app.put('/api/store-settings', requireOwner, route(async (req, res) => {
        const settings = {
            defaultFee: satang(req.body.defaultFee),
            electricityFee: req.body.electricityFee === undefined ? (await readSettings()).electricityFee : satang(req.body.electricityFee),
            gasDeliveryFee: satang(req.body.gasDeliveryFee),
            topupAmount: satang(req.body.topupAmount, 1),
        };
        await transaction(async (client) => {
            await client.query(`
                INSERT INTO transfer_settings (default_fee, gas_delivery_fee, topup_amount, electricity_fee) VALUES ($1,$2,$3,$4)
                ON CONFLICT (singleton) DO UPDATE SET default_fee = EXCLUDED.default_fee,
                    gas_delivery_fee = EXCLUDED.gas_delivery_fee, topup_amount = EXCLUDED.topup_amount, electricity_fee = EXCLUDED.electricity_fee
            `, [settings.defaultFee, settings.gasDeliveryFee, settings.topupAmount, settings.electricityFee]);
            await logAudit(client, req, 'UPDATE', 'STORE_SETTINGS', 'defaults', null, null, settings);
        });
        res.json(settings);
    }));

    app.put('/api/transfer-settings', requireOwner, route(async (req, res) => {
        const defaultFee = satang(req.body.defaultFee);
        await transaction(async (client) => {
            await client.query(`
                INSERT INTO transfer_settings (default_fee) VALUES ($1)
                ON CONFLICT (singleton) DO UPDATE SET default_fee = EXCLUDED.default_fee
            `, [defaultFee]);
            await logAudit(client, req, 'UPDATE', 'TRANSFER_SETTINGS', 'default_fee', null, null, { defaultFee });
        });
        res.json({ defaultFee });
    }));

    for (const serviceType of ['TRANSFER', 'ELECTRICITY']) {
        const transferPath = `/api/app-sessions/:sessionId/${serviceType === 'ELECTRICITY' ? 'electricity' : 'transfers'}`;
        const transferListSql = `SELECT t.*, COALESCE(u.display_name, u.username) AS staff
            FROM cash_transfers t JOIN app_users u ON u.id = t.created_by`;
        const resetTransferCheck = (client, sessionId) => client.query(
            "DELETE FROM app_session_closing_checks WHERE session_id = $1 AND section = $2", [sessionId, serviceType],
        );

        app.get(transferPath, requireOwner, route(async (req, res) => {
            const [totals, records, settings] = await Promise.all([
                transferClosingTotals(pool, req.params.sessionId, serviceType),
                pool.query(`${transferListSql} WHERE session_id = $1 AND service_type = $2 ORDER BY created_at DESC, id DESC LIMIT 100`, [req.params.sessionId, serviceType]),
                pool.query('SELECT default_fee, electricity_fee FROM transfer_settings'),
            ]);
            res.json({ totals, records: records.rows.map(transfer), defaultFee: Number(settings.rows[0]?.[serviceType === 'ELECTRICITY' ? 'electricity_fee' : 'default_fee'] ?? 0) });
        }));

        app.post(transferPath, requireOwner, route(async (req, res) => {
            const id = identifier(req.body.id);
            const principal = satang(req.body.principal, 1);
            const fee = satang(req.body.fee);
            // fee remains total shop income so existing reports reconcile; rounding is its explicit breakdown.
            const rounding = satang(req.body.rounding ?? 0);
            if (rounding > 99 || rounding > fee || (serviceType !== 'ELECTRICITY' && rounding !== 0)) {
                throw problem(400, 'ส่วนปัดเศษไม่ถูกต้อง');
            }
            if (req.body.rounding !== undefined && serviceType === 'ELECTRICITY' &&
                rounding !== (100 - (principal + fee - rounding) % 100) % 100) {
                throw problem(400, 'ยอดจ่ายค่าไฟต้องปัดยอดรวมขึ้นเป็นบาทเต็ม');
            }
            const cash = satang(req.body.cashReceived);
            const bank = clean(req.body.bank, 60);
            const reference = clean(req.body.reference, 100);
            const note = clean(req.body.note);
            if (cash < principal + fee) throw problem(400, 'เงินสดรับต่ำกว่ายอดที่ต้องเก็บ');
            if (serviceType === 'TRANSFER' && reference && !bank) throw problem(400, 'กรุณาระบุธนาคารพร้อมเลขอ้างอิง');

            const record = await transaction(async (client) => {
                const session = await ensureOpenAppSession(req.params.sessionId, client);
                const { rows: [row] } = await client.query(`
                    INSERT INTO cash_transfers (id, session_id, principal, fee, cash_received, bank, reference, note, created_by, service_type, rounding)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                    ON CONFLICT (id) DO NOTHING RETURNING *
                `, [id, session.session_id, principal, fee, cash, bank, reference, note, req.user.id, serviceType, rounding]);
                if (!row) {
                    const { rows: [existing] } = await client.query(`${transferListSql} WHERE t.id = $1`, [id]);
                    if (existing.service_type !== serviceType || existing.session_id !== session.session_id || existing.created_by !== req.user.id ||
                        Number(existing.principal) !== principal || Number(existing.fee) !== fee || Number(existing.rounding) !== rounding ||
                        Number(existing.cash_received) !== cash || existing.bank !== bank ||
                        existing.reference !== reference || existing.note !== note) {
                        throw problem(409, 'รหัสนี้ถูกใช้บันทึกรายการแล้ว');
                    }
                    return transfer(existing);
                }
                await resetTransferCheck(client, session.session_id);
                const result = transfer(row);
                await logAudit(client, req, 'CREATE', serviceType === 'ELECTRICITY' ? 'ELECTRICITY_PAYMENT' : 'CASH_TRANSFER', id, null, null, result);
                return result;
            });
            res.status(201).json(record);
        }));

        app.post(`${transferPath}/:id/cancel`, requireOwner, route(async (req, res) => {
            const id = identifier(req.params.id);
            const reason = clean(req.body.reason);
            if (!reason) throw problem(400, 'กรุณาระบุเหตุผลที่ยกเลิก');
            const record = await transaction(async (client) => {
                const session = await ensureOpenAppSession(req.params.sessionId, client);
                const { rows: [before] } = await client.query(
                    'SELECT * FROM cash_transfers WHERE session_id = $1 AND id = $2 AND service_type = $3 FOR UPDATE', [session.session_id, id, serviceType],
                );
                if (!before) throw problem(404, serviceType === 'ELECTRICITY' ? 'ไม่พบรายการจ่ายค่าไฟ' : 'ไม่พบรายการรับโอน');
                if (before.cancelled_at) return transfer(before);
                const { rows: [row] } = await client.query(
                    'UPDATE cash_transfers SET cancelled_at = NOW(), cancel_reason = $2 WHERE id = $1 RETURNING *', [id, reason],
                );
                await resetTransferCheck(client, session.session_id);
                await logAudit(client, req, 'CANCEL', serviceType === 'ELECTRICITY' ? 'ELECTRICITY_PAYMENT' : 'CASH_TRANSFER', id, reason, transfer(before), transfer(row));
                return transfer(row);
            });
            res.json(record);
        }));

    }

    const transferListSql = `SELECT t.*, COALESCE(u.display_name, u.username) AS staff
        FROM cash_transfers t JOIN app_users u ON u.id = t.created_by`;

    app.get('/api/tax-report', requireOwner, route(async (req, res) => {
        const start = monthStart(req.query.month);
        const inMonth = (column) => `${column} >= ($1::date::timestamp AT TIME ZONE 'Asia/Bangkok')
            AND ${column} < (($1::date + INTERVAL '1 month') AT TIME ZONE 'Asia/Bangkok')`;
        const [sales, topups, transfers, review] = await Promise.all([
            pool.query(`SELECT s.channel, COUNT(*)::int AS count, SUM(s.total * 100) AS amount
                FROM sales_records s LEFT JOIN gas_jobs g ON s.channel = 'GAS' AND g.id = s.id
                WHERE ${inMonth('s.created_at')} AND s.cancelled_at IS NULL
                  AND lower(s.status) NOT IN ('cancelled', 'ยกเลิก')
                  AND (lower(s.status) IN ('completed', 'done', 'success', 'สำเร็จ', 'เสร็จแล้ว') OR g.paid)
                GROUP BY s.channel ORDER BY s.channel`, [start]),
            pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount * 100), 0) AS amount
                FROM mobile_topup_orders WHERE ${inMonth('created_at')} AND paid AND topped_up AND status <> 'CANCELLED'`, [start]),
            pool.query(`${transferListSql} WHERE ${inMonth('t.created_at')}
                ORDER BY t.created_at DESC, t.id DESC`, [start]),
            pool.query('SELECT reviewed, note, updated_at AS "updatedAt" FROM tax_period_notes WHERE month = $1', [start]),
        ]);
        res.json({
            sales: [...sales.rows, { channel: 'TOPUP', ...topups.rows[0] }].map((row) => ({ ...row, amount: Number(row.amount) })),
            transfers: transfers.rows.map(transfer),
            review: review.rows[0] ?? { reviewed: false, note: '' },
        });
    }));

    app.put('/api/tax-report/:month/review', requireOwner, route(async (req, res) => {
        const start = monthStart(req.params.month);
        const reviewed = req.body.reviewed === true;
        const note = clean(req.body.note, 1500);
        const record = await transaction(async (client) => {
            const { rows: [row] } = await client.query(`
                INSERT INTO tax_period_notes (month, reviewed, note) VALUES ($1,$2,$3)
                ON CONFLICT (month) DO UPDATE SET reviewed = EXCLUDED.reviewed, note = EXCLUDED.note, updated_at = NOW()
                RETURNING reviewed, note, updated_at AS "updatedAt"
            `, [start, reviewed, note]);
            await logAudit(client, req, 'UPDATE', 'TAX_PERIOD', req.params.month, null, null, row);
            return row;
        });
        res.json(record);
    }));

    const orderPath = '/api/purchase-orders';
    const orderColumns = 'id, supplier, location, note, items, version, created_at AS "createdAt"';
    app.get(orderPath, requireOwner, route(async (_req, res) => {
        const { rows } = await pool.query(`SELECT ${orderColumns} FROM purchase_orders ORDER BY created_at DESC, id DESC`);
        res.json(rows);
    }));

    app.get(`${orderPath}/:id/receipts`, requireOwner, route(async (req, res) => {
        const { rows } = await pool.query(`SELECT id, version, restock, note, items, created_at AS "createdAt"
            FROM purchase_receipts WHERE order_id = $1 ORDER BY version DESC`, [identifier(req.params.id)]);
        res.json(rows);
    }));

    app.post(orderPath, requireOwner, route(async (req, res) => {
        const id = identifier(req.body.id);
        const supplier = clean(req.body.supplier, 120);
        const location = clean(req.body.location, 180);
        const note = clean(req.body.note);
        if (!supplier) throw problem(400, 'กรุณาระบุผู้ขาย');
        const quantities = itemQuantities(req.body.items, 'quantity', 1);
        const order = await transaction(async (client) => {
            const { rows: products } = await client.query(
                'SELECT id, name, barcode, unit FROM products WHERE id = ANY($1::int[]) AND active ORDER BY id', [[...quantities.keys()]],
            );
            if (products.length !== quantities.size) throw problem(409, 'มีสินค้าที่ถูกปิดใช้งานหรือไม่มีในสต็อก');
            const items = products.map(({ id: productId, ...product }) => ({
                productId, ...product, barcode: product.barcode ?? '', quantity: quantities.get(productId), received: 0,
            }));
            const { rows: [row] } = await client.query(`
                INSERT INTO purchase_orders (id, supplier, location, note, items, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
                ON CONFLICT (id) DO NOTHING RETURNING ${orderColumns}
            `, [id, supplier, location, note, JSON.stringify(items), req.user.id]);
            if (row) {
                await logAudit(client, req, 'CREATE', 'PURCHASE_ORDER', id, null, null, row);
                return row;
            }
            const { rows: [existing] } = await client.query(`SELECT ${orderColumns} FROM purchase_orders WHERE id = $1`, [id]);
            if (existing.supplier !== supplier || existing.location !== location || existing.note !== note || existing.items.length !== quantities.size ||
                existing.items.some((item) => item.quantity !== quantities.get(item.productId))) {
                throw problem(409, 'รหัสนี้ถูกใช้สร้างใบสั่งซื้อแล้ว');
            }
            return existing;
        });
        res.status(201).json(order);
    }));

    app.post(`${orderPath}/:id/receipts`, requireOwner, route(async (req, res) => {
        const orderId = identifier(req.params.id);
        const receiptId = identifier(req.body.id);
        const version = req.body.version;
        const restock = req.body.restock;
        const note = clean(req.body.note);
        if (!Number.isInteger(version) || version < 0 || typeof restock !== 'boolean') {
            throw problem(400, 'ข้อมูลรอบรับสินค้าไม่ถูกต้อง');
        }
        const quantities = itemQuantities(req.body.items, 'received', 0);
        const order = await transaction(async (client) => {
            const { rows: [before] } = await client.query(
                `SELECT ${orderColumns} FROM purchase_orders WHERE id = $1 FOR UPDATE`, [orderId],
            );
            if (!before) throw problem(404, 'ไม่พบใบสั่งซื้อ');
            const { rows: [existing] } = await client.query('SELECT * FROM purchase_receipts WHERE id = $1', [receiptId]);
            if (existing) {
                if (existing.order_id !== orderId || existing.version !== version + 1 || existing.restock !== restock ||
                    existing.note !== note || existing.items.length !== quantities.size ||
                    existing.items.some((item) => item.received !== quantities.get(item.productId))) {
                    throw problem(409, 'รหัสนี้ถูกใช้บันทึกรับของแล้ว');
                }
                return before;
            }
            if (before.version !== version) throw problem(409, 'มีการรับของรอบใหม่แล้ว กรุณาเปิดใบสั่งซื้อนี้อีกครั้ง');
            if (quantities.size !== before.items.length || before.items.some((item) => !quantities.has(item.productId))) {
                throw problem(400, 'รายการสินค้าไม่ตรงกับใบสั่งซื้อ');
            }
            if (![...quantities.values()].some(Boolean)) throw problem(400, 'กรุณากรอกยอดรับอย่างน้อยหนึ่งรายการ');
            if (before.items.every((item) => item.received >= item.quantity)) {
                throw problem(409, 'ใบสั่งซื้อนี้รับครบแล้ว');
            }
            if (!note && before.items.some((item) => quantities.get(item.productId) > Math.max(0, item.quantity - item.received))) {
                throw problem(400, 'กรุณาระบุเหตุผลเมื่อรับเกินจำนวนที่สั่ง');
            }
            const receiptItems = before.items.map(({ productId, name }) => ({ productId, name, received: quantities.get(productId) }));
            if (restock) {
                const ids = receiptItems.filter((item) => item.received > 0).map((item) => item.productId);
                const locked = await client.query(
                    'SELECT id FROM products WHERE id = ANY($1::int[]) AND active ORDER BY id FOR UPDATE', [ids],
                );
                if (locked.rowCount !== ids.length) throw problem(409, 'มีสินค้าที่ถูกปิดใช้งาน กรุณาเปิดใช้งานก่อนเพิ่มสต็อก');
                for (const item of receiptItems.filter((entry) => entry.received > 0)) {
                    await adjustProductStock(client, req, item.productId, item.received,
                        `รับสินค้า PO-${orderId.slice(0, 8).toUpperCase()}`, 'PURCHASE_RECEIPT', receiptId);
                }
            }
            await client.query(`
                INSERT INTO purchase_receipts (id, order_id, version, restock, note, items, created_by)
                VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
            `, [receiptId, orderId, version + 1, restock, note, JSON.stringify(receiptItems), req.user.id]);
            const items = before.items.map((item) => ({ ...item, received: item.received + quantities.get(item.productId) }));
            const { rows: [row] } = await client.query(`
                UPDATE purchase_orders SET items = $2::jsonb, version = version + 1 WHERE id = $1 RETURNING ${orderColumns}
            `, [orderId, JSON.stringify(items)]);
            await logAudit(client, req, 'CREATE', 'PURCHASE_RECEIPT', receiptId, note, before, { ...row, restock });
            return row;
        });
        res.status(201).json(order);
    }));

    const warehousePath = '/api/warehouse';
    app.get(warehousePath, requireOwner, route(async (_req, res) => {
        const [stock, history] = await Promise.all([
            pool.query(`SELECT p.id, p.name, COALESCE(p.barcode, '') AS barcode, p.unit, w.quantity, p.active
                FROM warehouse_stock w JOIN products p ON p.id = w.product_id
                ORDER BY p.name, p.id`),
            pool.query(`SELECT m.id, m.product_id, p.name, p.unit, m.delta, m.balance, m.note, m.created_at,
                COALESCE(u.display_name, u.username) AS actor
                FROM warehouse_movements m JOIN products p ON p.id = m.product_id
                JOIN app_users u ON u.id = m.created_by
                ORDER BY m.created_at DESC, m.id DESC LIMIT 100`),
        ]);
        res.json({ items: stock.rows, movements: history.rows });
    }));

    app.post(`${warehousePath}/movements`, requireOwner, route(async (req, res) => {
        const id = identifier(req.body.id);
        const { productId, delta } = req.body;
        const note = clean(req.body.note);
        if (!Number.isInteger(productId) || productId < 1 || productId > 2147483647 ||
            !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1000000) {
            throw problem(400, 'กรุณาเลือกสินค้าและระบุจำนวนให้ถูกต้อง');
        }
        const result = await transaction(async (client) => {
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [id]);
            const { rows: [existing] } = await client.query('SELECT * FROM warehouse_movements WHERE id = $1', [id]);
            if (existing) {
                if (existing.product_id !== productId || existing.delta !== delta || existing.note !== note || existing.created_by !== req.user.id) {
                    throw problem(409, 'รหัสนี้ถูกใช้กับรายการโกดังแล้ว');
                }
                return { id, balance: existing.balance };
            }
            if (delta > 0) {
                const { rows: [product] } = await client.query('SELECT active FROM products WHERE id = $1 FOR SHARE', [productId]);
                if (!product?.active) throw problem(409, 'สินค้านี้ไม่พร้อมเพิ่มเข้าโกดัง');
                await client.query('INSERT INTO warehouse_stock (product_id) VALUES ($1) ON CONFLICT DO NOTHING', [productId]);
            }
            const { rows: [stock] } = await client.query('SELECT quantity FROM warehouse_stock WHERE product_id = $1 FOR UPDATE', [productId]);
            const balance = (stock?.quantity ?? 0) + delta;
            if (balance < 0) throw problem(409, 'ของในโกดังไม่พอ กรุณาตรวจยอดล่าสุด');
            if (balance > 2147483647) throw problem(400, 'ยอดคงเหลือในโกดังเกินขีดจำกัด');
            await client.query('UPDATE warehouse_stock SET quantity = $2 WHERE product_id = $1', [productId, balance]);
            await client.query(`INSERT INTO warehouse_movements (id, product_id, delta, balance, note, created_by)
                VALUES ($1,$2,$3,$4,$5,$6)`, [id, productId, delta, balance, note, req.user.id]);
            return { id, balance };
        });
        res.status(201).json(result);
    }));

    const stockPath = '/api/stock/documents';
    const documentSql = `SELECT d.*, COALESCE(u.display_name, u.username) AS actor,
        COALESCE(s.display_name, s.username) AS settled_actor
        FROM stock_documents d JOIN app_users u ON u.id = d.created_by
        LEFT JOIN app_users s ON s.id = d.settled_by`;

    function stockKind(value) {
        if (value !== 'ISSUE' && value !== 'COUNT') throw problem(400, 'ประเภทเอกสารสต็อกไม่ถูกต้อง');
        return value;
    }

    app.get(stockPath, requireOwner, route(async (req, res) => {
        const { rows } = await pool.query(`${documentSql} WHERE d.kind = $1
            ORDER BY (d.kind = 'ISSUE' AND d.settled_at IS NULL) DESC, d.created_at DESC, d.id DESC LIMIT 100`,
        [stockKind(req.query.kind)]);
        res.json(rows);
    }));

    app.post(stockPath, requireOwner, route(async (req, res) => {
        const id = identifier(req.body.id);
        const kind = stockKind(req.body.kind);
        if (kind !== 'COUNT') throw problem(409, 'กรุณาเบิกของจากหน้าโกดัง');
        const note = clean(req.body.note);
        const quantities = itemQuantities(req.body.items, 'quantity', 0);
        const expected = itemQuantities(req.body.items, 'expected', 0, 2147483647);
        await transaction(async (client) => {
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [id]);
            const { rows: [existing] } = await client.query('SELECT * FROM stock_documents WHERE id = $1', [id]);
            if (existing) {
                if (existing.kind !== kind || existing.created_by !== req.user.id || existing.note !== note ||
                    existing.items.length !== quantities.size ||
                    existing.items.some((item) => item.quantity !== quantities.get(item.productId) ||
                        item.before !== expected.get(item.productId))) {
                    throw problem(409, 'รหัสนี้ถูกใช้กับเอกสารสต็อกแล้ว');
                }
                return;
            }
            const { rows: products } = await client.query(`
                SELECT id, name, unit, stock FROM products WHERE id = ANY($1::int[]) AND active ORDER BY id FOR UPDATE
            `, [[...quantities.keys()]]);
            if (products.length !== quantities.size) throw problem(409, 'มีสินค้าที่ไม่พร้อมใช้งาน กรุณาโหลดสต็อกล่าสุด');
            const items = products.map(({ id: productId, name, unit, stock: before }) => {
                const quantity = quantities.get(productId);
                if (expected.get(productId) !== before) {
                    throw problem(409, `ยอด ${name} ในระบบเปลี่ยนแล้ว กรุณาโหลดสต็อกล่าสุดและตรวจนับอีกครั้ง`);
                }
                return { productId, name, unit, before, quantity, after: quantity };
            });
            if (!note && items.some((item) => item.after !== item.before)) {
                throw problem(400, 'ระบุหมายเหตุสำหรับยอดตรวจนับที่ต่างจากระบบ');
            }
            const source = 'STOCK_COUNT';
            const reason = note || 'ตรวจนับสต็อก';
            for (const item of items) {
                if (item.after !== item.before) {
                    await adjustProductStock(client, req, item.productId, item.after - item.before, reason, source, id);
                }
            }
            await client.query(`INSERT INTO stock_documents (id, kind, note, items, created_by)
                VALUES ($1,$2,$3,$4::jsonb,$5)`, [id, kind, note, JSON.stringify(items), req.user.id]);
            await logAudit(client, req, 'CREATE', source, id, reason, null, { items });
        });
        res.status(201).json({ id });
    }));

    app.post(`${stockPath}/:id/settle`, requireOwner, route(async (req, res) => {
        const id = identifier(req.params.id);
        const arrived = itemQuantities(req.body.items, 'arrived', 0);
        const returned = itemQuantities(req.body.items, 'returned', 0);
        const note = clean(req.body.note);
        await transaction(async (client) => {
            const { rows: [doc] } = await client.query("SELECT * FROM stock_documents WHERE id = $1 AND kind = 'ISSUE' FOR UPDATE", [id]);
            if (!doc) throw problem(404, 'ไม่พบใบเบิกของ');
            if (arrived.size !== doc.items.length || doc.items.some((item) => !arrived.has(item.productId))) {
                throw problem(400, 'กรุณากรอกยอดปลายทางและยอดคืนให้ครบทุกสินค้า');
            }
            const settlement = doc.items.map(({ productId, name, quantity }) => {
                const delivered = arrived.get(productId);
                const returnedToStock = returned.get(productId);
                const missing = quantity - delivered - returnedToStock;
                if (missing < 0) throw problem(400, `ยอดถึงปลายทางและยอดคืนของ ${name} รวมกันเกินยอดเบิก`);
                return { productId, delivered, returnedToStock, missing };
            });
            if (doc.settled_at) {
                if (doc.settlement_note !== note || doc.settled_by !== req.user.id ||
                    doc.settlement.some((item, index) => item.delivered !== settlement[index].delivered ||
                        item.returnedToStock !== settlement[index].returnedToStock)) {
                    throw problem(409, 'ใบเบิกนี้ตรวจรับแล้ว กรุณาเปิดข้อมูลล่าสุด');
                }
                return;
            }
            if (!note && settlement.some((item) => item.missing)) throw problem(400, 'ระบุหมายเหตุสำหรับยอดที่ขาด');
            const returnItems = settlement.filter((item) => item.returnedToStock > 0);
            if (returnItems.length) {
                const locked = await client.query('SELECT id FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE',
                    [returnItems.map((item) => item.productId)]);
                if (locked.rowCount !== returnItems.length) throw problem(409, 'ไม่พบสินค้าบางรายการที่จะรับคืน');
                for (const item of returnItems) {
                    await adjustProductStock(client, req, item.productId, item.returnedToStock,
                        'คืนสินค้าจากใบเบิก', 'STOCK_ISSUE_RETURN', id);
                }
            }
            await client.query(`UPDATE stock_documents SET settled_at = NOW(), settled_by = $2,
                settlement_note = $3, settlement = $4::jsonb WHERE id = $1`, [id, req.user.id, note, JSON.stringify(settlement)]);
            await logAudit(client, req, 'SETTLE', 'STOCK_ISSUE', id, note, doc.items, settlement);
        });
        res.json({ id });
    }));
}

module.exports = { initializeStoreOperations, registerStoreOperations, transferClosingTotals, transferRecordsByDateRange };
