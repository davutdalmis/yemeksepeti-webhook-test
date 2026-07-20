// Plan 30 Faz 2.4 (2026-07-20) — Pipeline A stok yazımı kill-switch.
//
// Karar (K1): stok kanonu branchStocks/stockMovements'tır ve tek yazıcı
// production-domain'deki TransferStockEngine'dir (kurye teslimi anı).
// İrsaliye onayı (finalize/approval) SADECE belge akışını tamamlar;
// inventoryMovements / branchInventory / wasteRecords yazımları bu flag
// 'true' yapılmadıkça ATLANIR. İki motorun aynı anda stok yazması çifte
// sayım demektir — bu flag ile FEATURE_TRANSFER_STOCK_MOVE aynı anda
// açık OLMAMALIDIR (Railway env).
//
// Geri dönüş: INVOICING_STOCK_WRITES=true (eski davranış).
function invoicingStockWritesEnabled() {
    return process.env.INVOICING_STOCK_WRITES === 'true';
}

module.exports = { invoicingStockWritesEnabled };
