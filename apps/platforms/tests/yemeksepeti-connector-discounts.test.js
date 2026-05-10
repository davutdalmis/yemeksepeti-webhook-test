// ==================================================================================
// YemekSepetiConnector — Discount Transparency parse (15.05.2026)
// ==================================================================================
// YS, sipariş/ürün/topping seviyelerinde discounts[] + sponsorships[] (PLATFORM/VENDOR/
// THIRD_PARTY) breakdown'ı eklemiştir. Connector'ın bu alanları doğru normalize ettiğini
// (PascalCase + decimal) ve eski payload'larda boş array döndürdüğünü doğrula.
// ==================================================================================

jest.mock('firebase-admin', () => ({
    firestore: {
        FieldValue: {
            serverTimestamp: jest.fn().mockReturnValue('SERVER_TIMESTAMP'),
            increment: jest.fn().mockImplementation((n) => `INCREMENT(${n})`)
        }
    }
}));

const YemekSepetiConnector = require('../services/platforms/connectors/yemeksepeti-connector');

function createConnector() {
    return new YemekSepetiConnector({
        username: 'test',
        password: 'test',
        baseUrl: 'https://example.test'
    });
}

// YS doc'tan alınmış sample (Entegratör POS Guide_ Item Prices & Discounts Mapping.docx)
function buildNewPayload() {
    return {
        token: 'order-1',
        code: 'n0s1-w0k1',
        createdAt: '2026-05-15T10:00:00Z',
        customer: { firstName: 'Ali', lastName: 'Veli', mobilePhone: '+905551234567' },
        delivery: { address: { street: 'X', city: 'İstanbul' } },
        payment: { type: 'Online Kredi/Banka Kartı', status: 'paid' },
        price: {
            grandTotal: '25.50',
            deliveryFee: '5.00',
            discountAmountTotal: '9.00',
            collectFromCustomer: '0'
        },
        // ORDER-LEVEL discount (sponsorship breakdown YOK — doc'taki örnekteki gibi)
        discounts: [
            { name: 'Food Discount', amount: '9.00' }
        ],
        products: [
            {
                name: 'Double Cheese Burger',
                quantity: '2',
                unitPrice: '6',
                paidPrice: '12.00',
                comment: 'No cheese please',
                // PRODUCT-LEVEL discount (sponsorship breakdown VAR)
                discounts: [
                    {
                        name: 'Food Discount',
                        amount: '1.50',
                        sponsorships: [
                            { sponsor: 'PLATFORM', amount: '0.50' },
                            { sponsor: 'VENDOR', amount: '0.50' },
                            { sponsor: 'THIRD_PARTY', amount: '0.50' }
                        ]
                    }
                ],
                selectedToppings: [
                    {
                        name: 'extra cheese',
                        price: '1.50',
                        type: 'ADDITION',
                        // TOPPING-LEVEL discount (sponsorship breakdown VAR)
                        discounts: [
                            {
                                name: 'Food Discount',
                                amount: '1.50',
                                sponsorships: [
                                    { sponsor: 'PLATFORM', amount: '0.50' },
                                    { sponsor: 'VENDOR', amount: '0.50' },
                                    { sponsor: 'THIRD_PARTY', amount: '0.50' }
                                ]
                            }
                        ]
                    }
                ]
            }
        ],
        callbackUrls: { orderAcceptedUrl: 'http://example.test/accept' }
    };
}

function buildLegacyPayload() {
    // 15.05.2026 öncesi DH payload — discounts/sponsorships YOK
    return {
        token: 'legacy-1',
        code: 'old',
        createdAt: '2026-05-01T10:00:00Z',
        customer: { firstName: 'Ali', lastName: 'Veli', mobilePhone: '+905551234567' },
        delivery: { address: { street: 'X', city: 'İstanbul' } },
        payment: { type: 'Online', status: 'paid' },
        price: { grandTotal: '100.00', deliveryFee: '10.00', discountAmountTotal: '0' },
        products: [
            {
                name: 'Pizza',
                quantity: '1',
                unitPrice: '100.00',
                paidPrice: '100.00',
                selectedToppings: [{ name: 'extra', price: '0', type: 'ADDITION' }]
            }
        ],
        callbackUrls: {}
    };
}

describe('YemekSepetiConnector.transformOrder — Discount Transparency', () => {

    test('new payload: 3-level Discounts + Sponsorships parse edilir (PascalCase, decimal)', () => {
        const connector = createConnector();
        const result = connector.transformOrder(buildNewPayload(), 'branch-test');

        // Order-level
        expect(result.Discounts).toHaveLength(1);
        expect(result.Discounts[0].Name).toBe('Food Discount');
        expect(result.Discounts[0].Amount).toBe(9.00);
        expect(result.Discounts[0].Sponsorships).toEqual([]);

        // Item-level
        expect(result.Items).toHaveLength(1);
        const item = result.Items[0];
        expect(item.Discounts).toHaveLength(1);
        expect(item.Discounts[0].Name).toBe('Food Discount');
        expect(item.Discounts[0].Amount).toBe(1.50);
        expect(item.Discounts[0].Sponsorships).toHaveLength(3);

        // Sponsorship enum + amount
        const sponsors = item.Discounts[0].Sponsorships.map(s => s.Sponsor);
        expect(sponsors).toEqual(['PLATFORM', 'VENDOR', 'THIRD_PARTY']);
        const totalSponsorship = item.Discounts[0].Sponsorships
            .reduce((sum, s) => sum + s.Amount, 0);
        expect(totalSponsorship).toBeCloseTo(1.50, 2);

        // Topping-level
        expect(item.Options).toHaveLength(1);
        const topping = item.Options[0];
        expect(topping.Discounts).toHaveLength(1);
        expect(topping.Discounts[0].Sponsorships).toHaveLength(3);
    });

    test('legacy payload: discounts alanı yoksa Discounts boş array döner (backward compat)', () => {
        const connector = createConnector();
        const result = connector.transformOrder(buildLegacyPayload(), 'branch-test');

        expect(result.Discounts).toEqual([]);
        expect(result.Items[0].Discounts).toEqual([]);
        expect(result.Items[0].Options[0].Discounts).toEqual([]);
    });

    test('discounts var ama sponsorships eksik: Sponsorships boş array, crash yok', () => {
        const connector = createConnector();
        const payload = buildLegacyPayload();
        payload.discounts = [{ name: 'Loyalty', amount: '5.00' }]; // sponsorships yok

        const result = connector.transformOrder(payload, 'branch-test');

        expect(result.Discounts).toHaveLength(1);
        expect(result.Discounts[0].Name).toBe('Loyalty');
        expect(result.Discounts[0].Amount).toBe(5.00);
        expect(result.Discounts[0].Sponsorships).toEqual([]);
    });

    test('partial sponsorships (sadece VENDOR): doğru parse', () => {
        const connector = createConnector();
        const payload = buildLegacyPayload();
        payload.products[0].discounts = [{
            name: 'Food Discount',
            amount: '10.00',
            sponsorships: [{ sponsor: 'VENDOR', amount: '10.00' }]
        }];

        const result = connector.transformOrder(payload, 'branch-test');

        expect(result.Items[0].Discounts).toHaveLength(1);
        expect(result.Items[0].Discounts[0].Sponsorships).toHaveLength(1);
        expect(result.Items[0].Discounts[0].Sponsorships[0].Sponsor).toBe('VENDOR');
        expect(result.Items[0].Discounts[0].Sponsorships[0].Amount).toBe(10.00);
    });

    test('discounts null/undefined: empty array (defensive)', () => {
        const connector = createConnector();
        const payload = buildLegacyPayload();
        payload.discounts = null;
        payload.products[0].discounts = undefined;

        const result = connector.transformOrder(payload, 'branch-test');

        expect(result.Discounts).toEqual([]);
        expect(result.Items[0].Discounts).toEqual([]);
    });
});
