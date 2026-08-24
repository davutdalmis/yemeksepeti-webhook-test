// ==================================================================================
// ProductionOrderListener — Firestore listener: productionOrders.status='PENDING'
// ==================================================================================
// Plan 29 (2026-07-15, kullanıcı onayı): İrsaliye taslağı tetikleyicisi kurye zimmeti
// (stockTransfers.shipped) yerine SİPARİŞ ANI'na alındı. WPF'ten imalat siparişi
// oluştuğu anda (status=PENDING) invoiceDocuments'a documentKind='shipment' DRAFT
// yazılır — imalat onayı/üretim/kurye BEKLENMEZ. Panel /integrations/parasut
// "Bekleyen İrsaliye" listesine anında düşer; yetkilinin manuel onay akışı aynen kalır.
//
// Çift taslak önleme: Sevkiyat Günü transferi sonradan 'shipped' olursa
// StockTransferListener aynı mal için 2. shipment taslağı ÜRETMEZ — orada
// sourceTransferNumber (== orderNumber) eşleşen sipariş-tetikli doc aranır ve
// varsa yalnız linklenir (bkz. StockTransferListener._findOrderShipmentDoc).
//
// Yeni PENDING sipariş gelince:
//   1. order.parasutQueued === true -> kalem senkronu (_syncItemsIfChanged; 2026-08-24
//      "bekleyen siparişe ekleme": WPF PENDING siparişe sonradan ürün ekleyebilir —
//      2. taslak AÇILMAZ, mevcut taslağın kalemleri güncellenir) + return
//   2. Tenant settings yükle; isEnabled false -> skip
//   3. Master kill-switch (tenants/{id}.features.parasut_isEnabled) kapalı -> skip
//   4. shipmentMode 'disabled' -> skip (marker YAZILMAZ; mod açılınca backfill olur)
//   5. shipment DRAFT (idempotent: sha256(tenantId:productionOrder:orderId:shipment))
//   6. Siparişe parasutQueued=true + parasutShipmentDocumentId yaz
//   7. shipmentMode 'auto' ise Paraşüt'e POST /shipment_documents (manual'de panel tetikler)
//
// İptal güvenlik ağı: status='CANCELLED' + parasutQueued=true siparişlerde ilişkili
// shipment doc kesilmemişse otomatik void; kesilmişse (sent) manuel inceleme bayrağı.
// ==================================================================================

const { validateTransition } = require('../lib/StatusTransitionValidator');

/**
 * Sipariş kalemlerinden invoiceDocuments items snapshot'ı üretir.
 * ProductionOrderItem: {productId, productName, quantity, unit, unitPrice, totalPrice}
 * Hem ilk taslak üretimi hem sonradan kalem-ekleme senkronu bu TEK kaynağı kullanır —
 * iki ayrı map yazılsaydı alan listesi kaçınılmaz ayrışırdı.
 */
function buildItemsSnapshot(order) {
    return Array.isArray(order.items)
        ? order.items.map((it, idx) => ({
              itemIndex: idx,
              productId: it.productId || '',
              productName: it.productName || '',
              unit: it.unit || 'adet',
              unitPrice: Number(it.unitPrice || 0),
              vatRate: Number(it.vatRate || 0),
              originalQuantity: Number(it.quantity || 0),
              batchId: null,
              batchNumber: null,
          }))
        : [];
}

function snapshotAmount(items) {
    return items.reduce((sum, it) => sum + it.originalQuantity * it.unitPrice, 0);
}

/** Sıra dahil karşılaştırma — WPF birleştirme mevcut sırayı korur, yeniyi sona ekler. */
function snapshotsEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].productId !== b[i].productId) return false;
        if (Number(a[i].originalQuantity) !== Number(b[i].originalQuantity)) return false;
        if (Number(a[i].unitPrice) !== Number(b[i].unitPrice)) return false;
    }
    return true;
}

class ProductionOrderListener {
    /**
     * @param {object} deps
     * @param {object} deps.db Firestore db
     * @param {object} deps.idempotency IdempotencyService
     * @param {(tenantId: string) => Promise<object>} deps.settingsLoader
     * @param {string} [deps.collection] default 'productionOrders'
     * @param {(tenantId: string) => Promise<object>} [deps.providerFactory]
     * @param {object} [deps.tokenManager]
     * @param {(tenantId: string, doc: object) => Promise<object>} [deps.contextLoader]
     * @param {(tenantId: string) => Promise<boolean>} [deps.masterFlagLoader]
     */
    constructor({ db, idempotency, settingsLoader, collection = 'productionOrders', providerFactory, tokenManager, contextLoader, masterFlagLoader }) {
        if (!db) throw new Error('ProductionOrderListener: db required');
        if (!idempotency) throw new Error('ProductionOrderListener: idempotency required');
        if (!settingsLoader) throw new Error('ProductionOrderListener: settingsLoader required');
        this.db = db;
        this.idempotency = idempotency;
        this.settingsLoader = settingsLoader;
        this.collection = collection;
        this.providerFactory = providerFactory || null;
        this.tokenManager = tokenManager || null;
        this.contextLoader = contextLoader || null;
        this.masterFlagLoader = masterFlagLoader || null;
        this._unsubscribe = null;
        this._unsubscribeCancel = null;
    }

    start() {
        if (this._unsubscribe) return;
        // Not: WPF siparişi parasutQueued alanı YAZMAZ; where('parasutQueued','==',false)
        // alanı olmayan dokümanları eşleştirmediği için tek filtre status'tur.
        // Re-process koruması: handler'daki marker check + idempotent draft.
        const q = this.db.collection(this.collection)
            .where('status', '==', 'PENDING');

        this._unsubscribe = q.onSnapshot(
            (snapshot) => {
                snapshot.docChanges().forEach(async (change) => {
                    if (change.type === 'added' || change.type === 'modified') {
                        await this._handleOrder(change.doc).catch((e) => {
                            console.error(`[ProductionOrderListener] handle error for ${change.doc.id}:`, e.message);
                        });
                    }
                });
            },
            (err) => {
                console.error('[ProductionOrderListener] snapshot error:', err.message);
            }
        );
        console.log(`[ProductionOrderListener] subscribed to ${this.collection} where status=PENDING`);

        // İPTAL GÜVENLİK AĞI: taslak üretildikten sonra (parasutQueued=true) iptal edilen
        // siparişleri yakala; kesilmemiş belgeyi otomatik void et.
        const cancelQ = this.db.collection(this.collection)
            .where('status', '==', 'CANCELLED')
            .where('parasutQueued', '==', true);

        this._unsubscribeCancel = cancelQ.onSnapshot(
            (snapshot) => {
                snapshot.docChanges().forEach(async (change) => {
                    if (change.type === 'added' || change.type === 'modified') {
                        await this._handleCancellation(change.doc).catch((e) => {
                            console.error(`[ProductionOrderListener] cancel handle error for ${change.doc.id}:`, e.message);
                        });
                    }
                });
            },
            (err) => {
                console.error('[ProductionOrderListener] cancel snapshot error:', err.message);
            }
        );
        console.log(`[ProductionOrderListener] subscribed to ${this.collection} where status=CANCELLED (cancellation safety net)`);
    }

    stop() {
        if (this._unsubscribe) {
            this._unsubscribe();
            this._unsubscribe = null;
            console.log('[ProductionOrderListener] unsubscribed');
        }
        if (this._unsubscribeCancel) {
            this._unsubscribeCancel();
            this._unsubscribeCancel = null;
            console.log('[ProductionOrderListener] unsubscribed (cancel)');
        }
    }

    async _handleOrder(docSnap) {
        const order = docSnap.data();
        const orderId = docSnap.id;

        if (order.parasutQueued === true) {
            // 2026-08-24 kaleme-ekleme: taslak zaten üretilmiş — 2. taslak açma,
            // sipariş kalemleri değiştiyse mevcut taslağı senkronla.
            await this._syncItemsIfChanged(docSnap, order).catch((e) => {
                console.error(`[ProductionOrderListener] item sync error for ${orderId}:`, e.message);
            });
            return;
        }

        const tenantId = order.tenantId;
        if (!tenantId) {
            console.warn(`[ProductionOrderListener] order ${orderId} has no tenantId — skipping`);
            return;
        }

        let settings;
        try {
            settings = await this.settingsLoader(tenantId);
        } catch (e) {
            // Parasut kaydı olmayan tenant'lar (çoğunluk) — sessiz skip
            return;
        }

        if (!settings || settings.isEnabled === false) {
            return;
        }

        if (this.masterFlagLoader) {
            let masterOn = false;
            try {
                masterOn = await this.masterFlagLoader(tenantId);
            } catch (e) {
                console.warn(`[ProductionOrderListener] master flag read failed for ${tenantId} — skipping (${e.message})`);
            }
            if (!masterOn) return;
        }

        // Sipariş-anı akışı yalnız e-irsaliye (shipment) taslağı üretir. Fatura draft'ı
        // gerçek sevkiyat verisi ister — o akış StockTransferListener'da kalır.
        const shipmentMode = settings.shipmentMode || 'disabled';
        if (shipmentMode === 'disabled') return;

        // Kalem snapshot'ı — buildItemsSnapshot (ilk taslak + kalem-ekleme senkronu tek kaynak)
        const itemsSnapshot = buildItemsSnapshot(order);
        const amount = snapshotAmount(itemsSnapshot);

        // shippedAt=null: henüz sevkiyat yok. ShipmentProcessor.create tsToMs(null) -> "şimdi"
        // kullanır; transfer sonradan shipped olursa StockTransferListener gerçek zamanı yazar.
        const shipmentMeta = {
            shippedAt: null,
            shippedBy: null,
            sourceBranchId: null,
            targetBranchId: order.branchId || null,
            targetBranchName: order.branchName || null,
        };

        const draftData = {
            branchId: order.branchId,
            provider: 'parasut',
            // sourceTransferNumber == orderNumber: panel gösterimi + StockTransferListener
            // çift-taslak önleme eşleşmesi bu alan üzerinden (transferNumber = orderNumber).
            sourceTransferNumber: order.orderNumber || orderId,
            amount,
            currency: 'TRL',
            documentType: settings.defaultDocumentType || 'sales_invoice',
            shipmentIncluded: !!settings.shipmentIncludedDefault,
            items: itemsSnapshot,
            shipmentMeta,
        };

        const shipmentResult = await this.idempotency.ensureDraft({
            tenantId,
            sourceType: 'productionOrder',
            sourceId: orderId,
            documentKind: 'shipment',
            data: draftData,
        });

        try {
            await docSnap.ref.update({
                parasutQueued: true,
                parasutShipmentDocumentId: shipmentResult.id,
            });
        } catch (e) {
            console.warn(`[ProductionOrderListener] could not mark order ${orderId} as queued:`, e.message);
        }

        if (shipmentResult.existing === false) {
            console.log(`[ProductionOrderListener] shipment draft created for order ${order.orderNumber || orderId} -> doc ${shipmentResult.id}`);
        }

        // 'auto' modda Paraşüt'e anında POST; 'manual'de Firestore DRAFT kalır (panel tetikler).
        if (
            shipmentResult.existing === false &&
            shipmentMode === 'auto' &&
            this.providerFactory &&
            this.tokenManager &&
            this.contextLoader
        ) {
            await this._tryCreateParasutShipment({
                tenantId,
                docId: shipmentResult.id,
                orderId,
                order,
            });
        }
    }

    /**
     * 2026-08-24 — bekleyen siparişe kalem ekleme senkronu.
     * WPF, PENDING siparişin items[]'ına sonradan ürün ekleyebilir; taslak zaten
     * üretildiği için _handleOrder erken dönüyordu ve taslak ESKİ kalıyordu. Kurallar:
     *   - kalemler aynıysa NO-OP (PENDING doc'a gelen her 'modified' olayı ucuz çıkar)
     *   - taslak draft/pending_approval + yetkili elle düzenlememişse: items+amount
     *     güncelle + audit; Paraşüt'te taslak shipment varsa best-effort update
     *   - taslak ilerlemiş (sent/sending/approved/queued) VEYA approvalMeta.edits doluysa
     *     (itemIndex kayması eski edit'leri yanlış kaleme bağlar): DOKUNMA —
     *     itemsOutOfSync bayrağı + audit + warn (manuel inceleme)
     */
    async _syncItemsIfChanged(docSnap, order) {
        const orderId = docSnap.id;
        const docId = typeof order.parasutShipmentDocumentId === 'string' && order.parasutShipmentDocumentId.length > 0
            ? order.parasutShipmentDocumentId
            : null;
        if (!docId) return;

        const doc = await this.idempotency.getById(docId);
        if (!doc || doc.documentKind !== 'shipment') return;
        if (doc.status === 'cancelled') return; // iptal ağı ayrı akış

        const newItems = buildItemsSnapshot(order);
        // Boş listeye küçültme senkronla YAPILMAZ — sipariş iptali ayrı güvenlik ağında.
        if (newItems.length === 0) return;
        if (snapshotsEqual(doc.items || [], newItems)) return;

        const hasManualEdits = !!(doc.approvalMeta && Array.isArray(doc.approvalMeta.edits)
            && doc.approvalMeta.edits.length > 0);
        const syncable = (doc.status === 'draft' || doc.status === 'pending_approval') && !hasManualEdits;

        if (!syncable) {
            await this.idempotency.update(docId, { itemsOutOfSync: true });
            await this.idempotency.appendAudit(docId, 'items_out_of_sync', 'listener', {
                orderId,
                reason: hasManualEdits ? 'approval_edits_exist' : `status_${doc.status}`,
                orderItemCount: newItems.length,
                docItemCount: (doc.items || []).length,
            }).catch(() => {});
            console.warn(`[ProductionOrderListener] MANUAL REVIEW: order ${orderId} kalemleri değişti ama doc ${docId} senkronlanamaz (status=${doc.status}, manualEdits=${hasManualEdits})`);
            return;
        }

        const prevCount = (doc.items || []).length;
        const amount = snapshotAmount(newItems);
        await this.idempotency.update(docId, {
            items: newItems,
            amount,
            itemsOutOfSync: false,
        });
        await this.idempotency.appendAudit(docId, 'items_synced_from_order', 'listener', {
            orderId,
            prevItemCount: prevCount,
            newItemCount: newItems.length,
            amount,
        }).catch(() => {});
        console.log(`[ProductionOrderListener] items synced for doc ${docId} (order ${order.orderNumber || orderId}): ${prevCount} -> ${newItems.length} kalem, amount=${amount}`);

        // Paraşüt'te taslak shipment zaten oluşturulmuşsa (manual "İrsaliye Oluştur" ya da
        // auto mod) kalemleri orada da güncelle — ShipmentProcessor.saveEdits deseni.
        if (doc.parasutShipmentId && this.providerFactory && this.tokenManager) {
            try {
                const provider = await this.providerFactory(order.tenantId);
                const token = await this.tokenManager.getValidToken(order.tenantId);
                const itemsWithProductIds = [];
                for (const it of newItems) {
                    if (!it.originalQuantity || it.originalQuantity <= 0) continue;
                    const p = await provider.upsertProduct(token, {
                        name: it.productName,
                        sku: it.productId,
                        unit: it.unit,
                        vatRate: it.vatRate,
                    });
                    itemsWithProductIds.push({
                        productId: p.productId,
                        name: it.productName,
                        quantity: it.originalQuantity,
                        unitPrice: it.unitPrice,
                        vatRate: it.vatRate,
                    });
                }
                await provider.updateShipmentDocument(token, doc.parasutShipmentId, {
                    items: itemsWithProductIds,
                });
                await this.idempotency.appendAudit(docId, 'parasut_shipment_items_updated', 'listener', {
                    items: itemsWithProductIds.length,
                }).catch(() => {});
            } catch (e) {
                // Firestore güncel — panel bir sonraki saveEdits/finalize'da tam listeyi
                // zaten basar; burada akışı kırmak eklemeyi kaybettirir.
                console.warn(`[ProductionOrderListener] Parasut item update FAILED for ${docId}: ${e.message}`);
                await this.idempotency.appendAudit(docId, 'parasut_item_update_failed', 'listener', {
                    error: e.message,
                }).catch(() => {});
            }
        }
    }

    /**
     * İPTAL GÜVENLİK AĞI — CANCELLED sipariş + parasutQueued=true:
     *   - Belge KESİLMEMİŞ (draft/pending_approval/approved/queued/failed): otomatik void.
     *     Paraşüt'te taslak shipment_document varsa best-effort sil.
     *   - Belge KESİLMİŞ (sent): durumu DEĞİŞTİRME — cancellationRequested bayrağı + manuel inceleme.
     *   - sending: mid-flight, sadece bayrak.
     * Idempotency: siparişe parasutCancellationHandled=true damgası.
     */
    async _handleCancellation(docSnap) {
        const order = docSnap.data();
        const orderId = docSnap.id;

        if (order.parasutCancellationHandled === true) return;

        const docId = typeof order.parasutShipmentDocumentId === 'string' && order.parasutShipmentDocumentId.length > 0
            ? order.parasutShipmentDocumentId
            : null;

        if (!docId) {
            await this._markCancellationHandled(docSnap);
            return;
        }

        const tenantId = order.tenantId || null;

        try {
            const doc = await this.idempotency.getById(docId);
            if (!doc || doc.status === 'cancelled') {
                await this._markCancellationHandled(docSnap);
                return;
            }

            if (doc.status === 'sent') {
                await this.idempotency.update(docId, {
                    cancellationRequested: true,
                    cancellationRequestedAt: Date.now(),
                    cancellationReason: 'source_order_cancelled',
                });
                await this.idempotency.appendAudit(docId, 'order_cancelled_after_sent', 'listener', {
                    orderId,
                    note: 'Belge kesilmiş — iptal/iade MANUEL inceleme gerekir',
                }).catch(() => {});
                console.warn(`[ProductionOrderListener] MANUAL REVIEW: order ${orderId} iptal edildi ama doc ${docId} status=sent`);
                await this._markCancellationHandled(docSnap);
                return;
            }

            if (doc.status === 'sending') {
                await this.idempotency.update(docId, {
                    cancellationRequested: true,
                    cancellationRequestedAt: Date.now(),
                    cancellationReason: 'source_order_cancelled',
                });
                await this.idempotency.appendAudit(docId, 'order_cancelled_while_sending', 'listener', {
                    orderId,
                }).catch(() => {});
                await this._markCancellationHandled(docSnap);
                return;
            }

            // Paraşüt'te taslak shipment_document oluşturulmuşsa best-effort sil
            // (yetkili 'İrsaliye Oluştur' bastıktan sonra sipariş iptal edilirse).
            if (doc.parasutShipmentId && tenantId && this.providerFactory && this.tokenManager) {
                try {
                    const provider = await this.providerFactory(tenantId);
                    const token = await this.tokenManager.getValidToken(tenantId);
                    await provider.deleteShipmentDocument(token, doc.parasutShipmentId);
                    await this.idempotency.appendAudit(docId, 'parasut_shipment_deleted', 'listener', {
                        parasutShipmentId: doc.parasutShipmentId,
                    }).catch(() => {});
                    console.log(`[ProductionOrderListener] Parasut shipment ${doc.parasutShipmentId} silindi (doc ${docId})`);
                } catch (e) {
                    await this.idempotency.appendAudit(docId, 'parasut_shipment_delete_failed', 'listener', {
                        parasutShipmentId: doc.parasutShipmentId,
                        error: e.message,
                    }).catch(() => {});
                    console.warn(`[ProductionOrderListener] Parasut shipment delete FAILED ${doc.parasutShipmentId}: ${e.message}`);
                }
            }

            const check = validateTransition(doc.status, 'cancelled');
            if (!check.ok) {
                await this.idempotency.update(docId, {
                    cancellationRequested: true,
                    cancellationRequestedAt: Date.now(),
                    cancellationReason: 'source_order_cancelled',
                });
                console.warn(`[ProductionOrderListener] doc ${docId} ${check.reason} — bayrakla bırakıldı`);
                await this._markCancellationHandled(docSnap);
                return;
            }

            await this.idempotency.update(docId, {
                status: 'cancelled',
                cancellationReason: 'source_order_cancelled',
                cancelledAt: Date.now(),
            });
            await this.idempotency.appendAudit(docId, 'order_cancelled_auto_void', 'listener', {
                orderId,
                fromStatus: doc.status,
            }).catch(() => {});
            console.log(`[ProductionOrderListener] doc ${docId} (status=${doc.status}) -> cancelled (order ${orderId} iptal)`);
        } catch (e) {
            console.warn(`[ProductionOrderListener] cancellation handling FAILED for doc ${docId}: ${e.message}`);
        }

        await this._markCancellationHandled(docSnap);
    }

    async _markCancellationHandled(docSnap) {
        try {
            await docSnap.ref.update({
                parasutCancellationHandled: true,
                parasutCancellationHandledAt: Date.now(),
            });
        } catch (e) {
            console.warn(`[ProductionOrderListener] could not mark order ${docSnap.id} cancellation-handled:`, e.message);
        }
    }

    /**
     * 'auto' modda Paraşüt'e shipment_document POST eder. shipmentDate = şimdi
     * (fiziksel sevkiyat henüz yok — sipariş anı akışı). Hata fatal değil.
     */
    async _tryCreateParasutShipment({ tenantId, docId, orderId, order }) {
        try {
            const provider = await this.providerFactory(tenantId);
            const token = await this.tokenManager.getValidToken(tenantId);
            const ctx = await this.contextLoader(tenantId, {
                tenantId,
                sourceType: 'productionOrder',
                sourceId: orderId,
                branchId: order.branchId,
            });

            const contact = await provider.upsertContact(token, {
                ...ctx.branch,
                id: ctx.branch.id || order.branchId,
            });

            const itemsWithProductIds = [];
            for (const it of (ctx.items || [])) {
                if (!it.quantity || it.quantity <= 0) continue;
                const p = await provider.upsertProduct(token, {
                    name: it.productName || it.name,
                    sku: it.productId || it.sku,
                    unit: it.unit,
                    vatRate: it.vatRate,
                });
                itemsWithProductIds.push({
                    productId: p.productId,
                    name: it.productName || it.name,
                    description: it.productName || it.name,
                    quantity: it.quantity,
                    unitPrice: it.unitPrice,
                    vatRate: it.vatRate,
                });
            }

            if (itemsWithProductIds.length === 0) {
                console.warn(`[ProductionOrderListener] doc ${docId} has 0 valid items for Parasut shipment — skipping POST`);
                return;
            }

            const shipment = await provider.createShipmentDocument(token, {
                contactId: contact.contactId,
                items: itemsWithProductIds,
                issueDate: ctx.issueDate,
                shipmentDate: new Date().toISOString(),
                address: ctx.branch && ctx.branch.address,
                city: ctx.branch && ctx.branch.city,
                district: ctx.branch && ctx.branch.district,
                inflow: false,
            });

            await this.idempotency.update(docId, {
                parasutShipmentId: shipment.providerShipmentId,
                parasutShipmentNumber: shipment.shipmentNumber,
                parasutContactId: contact.contactId,
                pdfUrl: shipment.pdfUrl,
                parasutShipmentCreatedAt: Date.now(),
            });
            await this.idempotency.appendAudit(docId, 'parasut_shipment_created', 'listener', {
                parasutShipmentId: shipment.providerShipmentId,
                items: itemsWithProductIds.length,
            }).catch(() => {});

            console.log(`[ProductionOrderListener] Parasut shipment created for ${docId} -> parasutShipmentId=${shipment.providerShipmentId}`);
        } catch (e) {
            console.warn(`[ProductionOrderListener] Parasut shipment create FAILED for ${docId}: ${e.reqMethod || ''} ${e.reqUrl || ''} -> ${e.status} ${e.message} (code=${e.code || '?'})`);
            await this.idempotency.appendAudit(docId, 'parasut_shipment_failed', 'listener', {
                error: e.message,
                code: e.code,
                status: e.status,
            }).catch(() => {});
        }
    }
}

module.exports = ProductionOrderListener;
