import { pilotRecipe } from './economy-catalogue.js';
import catalogue from './catalogue.v2.json' with {type:'json'};
export const catalogueRecipes = Object.freeze(catalogue.items.filter(item=>item.transferability==='tradable')
  .map(item=>Object.freeze({recipeId:item.recipeId,version:item.recipeVersion,sku:item.sku,label:item.label,
    licenseId:item.licenseRequirement.produce})));
export const catalogueUpgrade = Object.freeze({
  previous: '7LWg81dHFSDaiH56vpLZ3hVuABFRCWTFvx6Es7Dysvfn',
  codeHash: 'DZDYZeiNQurAcTh77jNPQ9UVD4CpjgjSfwMxZQBFRafz',
  sha256: 'ba8d03449efc0995c33a7a6e72ebf44e8b0bd974e13cbefce3b182abca26b419',
});
export const professionUpgrade = Object.freeze({
  previous: catalogueUpgrade.codeHash,
  codeHash: 'G6bWtC7Pdw29eFFi3Uv8tzV6mHSfQUvbNuMVsbZGrjbW',
  sha256: 'e04e3c030b99c916f64c77c6c8f0ea6e40606a1b8722012edfe034ae58de86d1',
});
export const guildMissionUpgrade = Object.freeze({
  previous: professionUpgrade.codeHash,
  codeHash: 'nYApJ15WBCFP6H7jzmKBrUPj6oTFrd7u1qVT7NKdN8r',
  sha256: '0baa612b83e6cde0d3d353a1aab763d31a33a19b7a0ad14e7a1c162f8ba6c71b',
});
export const economyDeployment = Object.freeze({
  "accountId": "economy.xuancanh1.testnet",
  "codeHash": "7LWg81dHFSDaiH56vpLZ3hVuABFRCWTFvx6Es7Dysvfn",
  upgradeCodeHash: catalogueUpgrade.codeHash,
  professionCodeHash: professionUpgrade.codeHash,
  acceptedCodeHashes: Object.freeze([catalogueUpgrade.previous, catalogueUpgrade.codeHash, professionUpgrade.codeHash, guildMissionUpgrade.codeHash]),
  recipes: Object.freeze([pilotRecipe])
});
