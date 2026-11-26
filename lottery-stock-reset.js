const crypto = require('node:crypto');

function registerLotteryStockReset(app, { pool, requireOwner, adjustLotteryStock, logAudit }) {
    const readPreview = async (client, lock = false) => {
        const { rows } = await client.query(`SELECT id, number, remaining, stock_reference, stock_generation
            FROM lottery_tickets WHERE number ~ '^[0-9]{2}$' ORDER BY id ${lock ? 'FOR UPDATE' : ''}`);
        const { rows: [pending] } = await client.query("SELECT COUNT(*)::int AS count FROM sales_records WHERE channel = 'LOTTERY' AND status = 'รอเจ้าของร้านยืนยัน'");
        return { rows, ticketCount: rows.length, total: rows.reduce((sum, ticket) => sum + ticket.remaining, 0),
            pendingCount: pending.count, version: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
    };
    const summary = ({ rows, ...preview }) => preview;
    app.get('/api/lottery/stock/reset-preview', requireOwner, async (_req, res) => {
        try { res.json(summary(await readPreview(pool))); }
        catch { res.status(500).json({ error: 'โหลดสรุปสต็อกสลากไม่สำเร็จ' }); }
    });
    app.post('/api/lottery/stock/reset', requireOwner, async (req, res) => {
        const reason = String(req.body.reason || '').trim();
        if (req.body.confirm !== 'RESET_LOTTERY_STOCK' || !reason || reason.length > 500 || !/^[a-f0-9]{64}$/.test(req.body.expectedVersion || '')) {
            return res.status(400).json({ error: 'กรุณาตรวจยอด ระบุเหตุผล และยืนยันเคลียร์สต็อกสลาก' });
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(7719002)');
            const preview = await readPreview(client, true);
            if (preview.version !== req.body.expectedVersion) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'สต็อกเปลี่ยนระหว่างตรวจ กรุณาดูยอดล่าสุดก่อนยืนยันอีกครั้ง', preview: summary(preview) });
            }
            const resetId = crypto.randomUUID();
            const ids = preview.rows.map(ticket => ticket.id);
            for (const ticket of preview.rows) {
                if (ticket.remaining) await adjustLotteryStock(client, req, ticket.id, -ticket.remaining, reason, 'LOTTERY_PERIOD_RESET', resetId);
            }
            await client.query(`UPDATE lottery_tickets SET remaining = 0, stock_reference = 0,
                stock_generation = stock_generation + 1, updated_at = NOW() WHERE id = ANY($1::int[])`, [ids]);
            const carts = await client.query('DELETE FROM lottery_cart_items WHERE ticket_id = ANY($1::int[]) RETURNING session_id', [ids]);
            const sessions = [...new Set(carts.rows.map(item => item.session_id))];
            if (sessions.length) await client.query('UPDATE lottery_cart_sessions SET updated_at = NOW() WHERE session_id = ANY($1::varchar[])', [sessions]);
            const result = { resetId, cleared: preview.total, ticketCount: preview.ticketCount, pendingCount: preview.pendingCount,
                clearedCartLines: carts.rowCount };
            await logAudit(client, req, 'RESET_STOCK', 'LOTTERY_PERIOD', resetId, reason, preview.rows, result);
            await client.query('COMMIT');
            res.json(result);
        } catch {
            await client.query('ROLLBACK');
            res.status(500).json({ error: 'เคลียร์สต็อกสลากไม่สำเร็จ ยังไม่เปลี่ยนข้อมูล กรุณาลองใหม่' });
        } finally { client.release(); }
    });
}

module.exports = { registerLotteryStockReset };
