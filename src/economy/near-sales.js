import { accountId, atomic } from './schema.js';
import { orderPriceAtomic, orderFillQuote } from './near-orders.js';
const op = value => { if (!/^[a-zA-Z0-9-]{1,64}$/.test(value)) throw new Error('Invalid sale operation.'); return value; };
const id = value => { if(typeof value!=='string'||value.length>129||!/^.+:.+$/.test(value))throw new Error('Invalid cosmetic sale ID.');return value; };
function snapshot(sale){return {sellerId:accountId(sale.sellerId),itemId:id(sale.itemId),sku:sale.sku,recipeId:sale.recipeId,recipeVersion:sale.recipeVersion,transferVersion:sale.transferVersion,priceAtomic:atomic(sale.priceAtomic).toString(),expiresAtMs:sale.expiresAtMs};}
function same(a,b){return Object.keys(a).every(key=>a[key]===b?.[key]);}
export function listingDraft({economy,seller,operationId,item,transferVersion,price,expiresAtMs,storageCharge,now=Date.now()}){
 accountId(seller);accountId(economy);op(operationId);
 if(item?.ownerId!==seller||!Number.isSafeInteger(transferVersion)||transferVersion<0||!Number.isSafeInteger(item.recipeVersion)||typeof item.sku!=='string'||typeof item.recipeId!=='string')throw new Error('Choose a cosmetic owned by this wallet.');
 if(!Number.isSafeInteger(expiresAtMs)||expiresAtMs<=now||expiresAtMs-now>30*86400000)throw new Error('Choose a future sale expiry within 30 days.');
 if(atomic(storageCharge)<=0n)throw new Error('Listing storage charge unavailable.');
 const expected=snapshot({...item,sellerId:seller,transferVersion,priceAtomic:orderPriceAtomic(price).toString(),expiresAtMs});
 return {kind:'list',id:seller+':'+operationId,account:seller,receiverId:economy,deposit:storageCharge,expected,quote:orderFillQuote(expected.priceAtomic,250),
 args:{operation_id:operationId,item_id:item.itemId,expected_transfer_version:transferVersion,price_atomic:expected.priceAtomic,expires_at_ms:expiresAtMs}};
}
export function listingMatches(sale,draft){return !!sale&&same(draft.expected,sale);}
export function buySaleDraft({economy,token,buyer,operationId,saleId,sale,currentVersion,now=Date.now()}){
 accountId(buyer);op(operationId);id(saleId);
 if(!sale||sale.status!=='open'||sale.sellerId===buyer||sale.expiresAtMs<=now||sale.transferVersion!==currentVersion)throw new Error('Sale is closed, expired, stale, or belongs to this wallet.');
 const expected=snapshot(sale);
 return {kind:'buy',account:buyer,receiverId:accountId(token),economy:accountId(economy),saleId,operationId,expected,quote:orderFillQuote(expected.priceAtomic,250),deposit:'1',
 args:{receiver_id:economy,amount:expected.priceAtomic,msg:JSON.stringify({action:'buy_sale',operationId,saleId})}};
}
export function saleTermsMatch(sale,draft,currentVersion){return !!sale&&sale.status==='open'&&same(draft.expected,sale)&&sale.transferVersion===currentVersion;}
export function purchaseConfirmed(sale,item,receipt,draft){return !!sale&&same(draft.expected,sale)&&sale.status==='sold'&&sale.buyerId===draft.account&&sale.purchaseOperationId===draft.operationId&&receipt===draft.saleId&&item?.ownerId===draft.account&&item.itemId===draft.expected.itemId&&item.sku===draft.expected.sku&&item.recipeId===draft.expected.recipeId&&item.recipeVersion===draft.expected.recipeVersion;}
