import { objectiveFromNft } from './chog-objectives.js';

// Starter targets use the published Fox collection metadata.
const foxes = [
  {
    "tokenId": "001",
    "name": "NEAR Fox #001",
    "image": "https://near-fox-testnet-media.vercel.app/images/001.png",
    "attributes": [
      {
        "trait_type": "Background",
        "value": "Butter Yellow"
      },
      {
        "trait_type": "Outfit",
        "value": "Pink Hoodie"
      },
      {
        "trait_type": "Headwear",
        "value": "Cyan Bucket Hat"
      },
      {
        "trait_type": "Accessory",
        "value": "None"
      },
      {
        "trait_type": "Expression",
        "value": "Classic Smile"
      },
      {
        "trait_type": "Eyewear",
        "value": "None"
      }
    ]
  },
  {
    "tokenId": "002",
    "name": "NEAR Fox #002",
    "image": "https://near-fox-testnet-media.vercel.app/images/002.png",
    "attributes": [
      {
        "trait_type": "Background",
        "value": "Butter Yellow"
      },
      {
        "trait_type": "Outfit",
        "value": "Pink Hoodie"
      },
      {
        "trait_type": "Headwear",
        "value": "Brick Baseball Cap"
      },
      {
        "trait_type": "Accessory",
        "value": "Cheek Bandage"
      },
      {
        "trait_type": "Expression",
        "value": "Classic Smile"
      },
      {
        "trait_type": "Eyewear",
        "value": "Sport Visor"
      }
    ]
  },
  {
    "tokenId": "003",
    "name": "NEAR Fox #003",
    "image": "https://near-fox-testnet-media.vercel.app/images/003.png",
    "attributes": [
      {
        "trait_type": "Background",
        "value": "Butter Yellow"
      },
      {
        "trait_type": "Outfit",
        "value": "Pink Hoodie"
      },
      {
        "trait_type": "Headwear",
        "value": "Mustard Beanie"
      },
      {
        "trait_type": "Accessory",
        "value": "Cheek Bandage"
      },
      {
        "trait_type": "Expression",
        "value": "Little Fang"
      },
      {
        "trait_type": "Eyewear",
        "value": "Sport Visor"
      }
    ]
  },
  {
    "tokenId": "004",
    "name": "NEAR Fox #004",
    "image": "https://near-fox-testnet-media.vercel.app/images/004.png",
    "attributes": [
      {
        "trait_type": "Background",
        "value": "Butter Yellow"
      },
      {
        "trait_type": "Outfit",
        "value": "Plum Varsity"
      },
      {
        "trait_type": "Headwear",
        "value": "Cyan Bucket Hat"
      },
      {
        "trait_type": "Accessory",
        "value": "Gold Hoop"
      },
      {
        "trait_type": "Expression",
        "value": "Playful Wink"
      },
      {
        "trait_type": "Eyewear",
        "value": "Round Frames"
      }
    ]
  },
  {
    "tokenId": "005",
    "name": "NEAR Fox #005",
    "image": "https://near-fox-testnet-media.vercel.app/images/005.png",
    "attributes": [
      {
        "trait_type": "Background",
        "value": "Butter Yellow"
      },
      {
        "trait_type": "Outfit",
        "value": "Plum Varsity"
      },
      {
        "trait_type": "Headwear",
        "value": "Brick Baseball Cap"
      },
      {
        "trait_type": "Accessory",
        "value": "None"
      },
      {
        "trait_type": "Expression",
        "value": "Little Fang"
      },
      {
        "trait_type": "Eyewear",
        "value": "Round Frames"
      }
    ]
  },
  {
    "tokenId": "006",
    "name": "NEAR Fox #006",
    "image": "https://near-fox-testnet-media.vercel.app/images/006.png",
    "attributes": [
      {
        "trait_type": "Background",
        "value": "Butter Yellow"
      },
      {
        "trait_type": "Outfit",
        "value": "Plum Varsity"
      },
      {
        "trait_type": "Headwear",
        "value": "Mustard Beanie"
      },
      {
        "trait_type": "Accessory",
        "value": "Cheek Bandage"
      },
      {
        "trait_type": "Expression",
        "value": "Playful Wink"
      },
      {
        "trait_type": "Eyewear",
        "value": "None"
      }
    ]
  }
];

export function nearHuntObjective(slot) {
  const fox = foxes[slot % foxes.length];
  return objectiveFromNft({ ...fox, contract: 'fox.xuancanh1.testnet' });
}
