const MockInvoiceProvider = require('../providers/MockInvoiceProvider');

describe('MockInvoiceProvider', () => {
    test('counts calls', async () => {
        const m = new MockInvoiceProvider();
        await m.authenticate();
        await m.upsertContact('t', { taxNumber: '1' });
        await m.createInvoice('t', { contactId: 'c', items: [{ productId: 'p', quantity: 1, unitPrice: 1 }] });
        expect(m.calls.authenticate).toBe(1);
        expect(m.calls.upsertContact).toBe(1);
        expect(m.calls.createInvoice).toBe(1);
    });

    test('createInvoice + getDocument round-trip', async () => {
        const m = new MockInvoiceProvider();
        const inv = await m.createInvoice('t', { contactId: 'c', items: [{ productId: 'p', quantity: 1, unitPrice: 100 }] });
        const got = await m.getDocument('t', inv.providerInvoiceId);
        expect(got.pdfUrl).toBe(inv.pdfUrl);
    });

    test('getDocument throws for unknown id', async () => {
        const m = new MockInvoiceProvider();
        await expect(m.getDocument('t', 'nope')).rejects.toMatchObject({ code: 'DOC_NOT_FOUND' });
    });

    test('failNext injects error then resets', async () => {
        const m = new MockInvoiceProvider();
        m.failNext = { message: 'simulated', code: 'SIM', retryable: true };
        await expect(m.authenticate()).rejects.toMatchObject({ code: 'SIM' });
        await expect(m.authenticate()).resolves.toBeDefined();
    });
});
