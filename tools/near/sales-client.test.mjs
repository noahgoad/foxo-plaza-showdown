import test from 'node:test';
import assert from 'node:assert/strict';
import { listingDraft, buySaleDraft, listingMatches, purchaseConfirmed, saleTermsMatch } from '../../src/economy/near-sales.js';
const item={itemId:'alice.testnet:one',ownerId:'alice.testnet',sku:'finish-a',recipeId:'finish',recipeVersion:1};
const fields={economy:'economy.testnet',seller:'alice.testnet',operationId:'list-1',item,transferVersion:2,price:'0.000000000000000000010001',expiresAtMs:2000,storageCharge:'40960000000000000000000',now:1000};
const sale={sellerId:fields.seller,itemId:item.itemId,sku:item.sku,recipeId:item.recipeId,recipeVersion:1,transferVersion:2,priceAtomic:'10001',expiresAtMs:2000,status:'open',buyerId:null};
test('listing review binds exact native charge, one cosmetic and immutable snapshot',()=>{
 const draft=listingDraft(fields);assert.equal(draft.id,'alice.testnet:list-1');assert.equal(draft.deposit,fields.storageCharge);assert.equal(draft.args.price_atomic,'10001');
 assert.ok(listingMatches(sale,draft));assert.equal(listingMatches({...sale,transferVersion:3},draft),false);
 assert.throws(()=>listingDraft({...fields,item:{...item,ownerId:'other.testnet'}}));assert.throws(()=>listingDraft({...fields,price:'1e3'}));
});
test('buy review and confirmation require matching sale, operation receipt and delivered authoritative owner',()=>{
 const draft=buySaleDraft({economy:fields.economy,token:'foxo.testnet',buyer:'bob.testnet',operationId:'buy-1',saleId:'alice.testnet:list-1',sale,currentVersion:2,now:1000});
 assert.equal(draft.args.amount,'10001');assert.equal(draft.quote.feeAtomic,'250');assert.equal(draft.quote.netAtomic,'9751');
 assert.deepEqual(JSON.parse(draft.args.msg),{action:'buy_sale',operationId:'buy-1',saleId:'alice.testnet:list-1'});
 assert.ok(saleTermsMatch(sale,draft,2));assert.equal(saleTermsMatch(sale,draft,3),false);
 const sold={...sale,status:'sold',buyerId:'bob.testnet',purchaseOperationId:'buy-1'},delivered={...item,ownerId:'bob.testnet'};
 assert.ok(purchaseConfirmed(sold,delivered,draft.saleId,draft));
 assert.equal(purchaseConfirmed(sold,delivered,null,draft),false);
 assert.equal(purchaseConfirmed({...sold,purchaseOperationId:'other'},delivered,draft.saleId,draft),false);
 assert.equal(purchaseConfirmed(sold,item,draft.saleId,draft),false);
 assert.throws(()=>buySaleDraft({economy:fields.economy,token:'foxo.testnet',buyer:fields.seller,operationId:'buy-1',saleId:'alice.testnet:list-1',sale,currentVersion:2,now:1000}));
});
