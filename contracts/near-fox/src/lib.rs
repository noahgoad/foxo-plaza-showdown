use near_contract_standards::non_fungible_token::{
    core::{NonFungibleTokenCore, NonFungibleTokenResolver},
    metadata::{
        NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
    },
    NonFungibleToken, Token, TokenId,
};
use near_sdk::{
    borsh::BorshSerialize, collections::LazyOption, env, near, require, AccountId, BorshStorageKey,
    PanicOnDefault, Promise, PromiseOrValue,
};

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Storage {
    Tokens,
    Metadata,
    TokenMetadata,
    Enumeration,
    Approvals,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        let expected_account = format!("fox.{owner_id}");
        require!(
            env::predecessor_account_id() == env::current_account_id()
                || (env::predecessor_account_id() == owner_id
                    && env::current_account_id().as_str() == expected_account),
            "Only the contract account or its parent can initialize"
        );
        Self {
            tokens: NonFungibleToken::new(
                Storage::Tokens,
                owner_id,
                Some(Storage::TokenMetadata),
                Some(Storage::Enumeration),
                Some(Storage::Approvals),
            ),
            metadata: LazyOption::new(
                Storage::Metadata,
                Some(&NFTContractMetadata {
                    spec: NFT_METADATA_SPEC.into(),
                    name: "NEAR Fox".into(),
                    symbol: "NFOX".into(),
                    icon: None,
                    base_uri: None,
                    reference: None,
                    reference_hash: None,
                }),
            ),
        }
    }

    #[payable]
    pub fn nft_mint(
        &mut self,
        token_id: TokenId,
        receiver_id: AccountId,
        token_metadata: TokenMetadata,
    ) -> Token {
        require!(
            env::predecessor_account_id() == self.tokens.owner_id,
            "Only the collection owner can mint"
        );
        let number = token_id.parse::<u8>().unwrap_or_default();
        require!(
            (1..=88).contains(&number) && token_id == format!("{number:03}"),
            "Token ID must be 001 through 088"
        );
        token_metadata.assert_valid();
        require!(
            token_metadata
                .media
                .as_deref()
                .is_some_and(|url| url.starts_with("https://") || url.starts_with("ipfs://")),
            "Public media URL required"
        );
        self.tokens
            .internal_mint(token_id, receiver_id, Some(token_metadata))
    }
}

#[allow(deprecated)]
const _: () = {
    near_contract_standards::impl_non_fungible_token_approval!(Contract, tokens);
    near_contract_standards::impl_non_fungible_token_enumeration!(Contract, tokens);
};

impl Contract {
    fn epoch_key(token_id: &str) -> Vec<u8> {
        [b"fox/ownership-epoch/v1/".as_slice(), token_id.as_bytes()].concat()
    }

    fn bump_epoch(&self, token_id: &str) {
        let key = Self::epoch_key(token_id);
        let previous = env::storage_read(&key)
            .map(|bytes| u64::from_le_bytes(bytes.try_into().expect("Invalid ownership epoch")))
            .unwrap_or(0);
        let next = previous.checked_add(1).expect("Ownership epoch overflow");
        env::storage_write(&key, &next.to_le_bytes());
    }
}

#[near]
impl Contract {
    pub fn get_ownership_epoch(&self, token_id: TokenId) -> Option<near_sdk::json_types::U64> {
        self.tokens.owner_by_id.get(&token_id)?;
        let epoch = env::storage_read(&Self::epoch_key(&token_id))
            .map(|bytes| u64::from_le_bytes(bytes.try_into().expect("Invalid ownership epoch")))
            .unwrap_or(0);
        Some(near_sdk::json_types::U64(epoch))
    }
}

#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId,
        approval_id: Option<u64>, memo: Option<String>) {
        self.tokens.nft_transfer(receiver_id, token_id.clone(), approval_id, memo);
        self.bump_epoch(&token_id);
    }

    #[payable]
    fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: TokenId,
        approval_id: Option<u64>, memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        let promise = self.tokens.nft_transfer_call(receiver_id, token_id.clone(), approval_id, memo, msg);
        self.bump_epoch(&token_id);
        promise
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId,
        token_id: TokenId, approved_account_ids: Option<std::collections::HashMap<AccountId, u64>>) -> bool {
        let before = self.tokens.owner_by_id.get(&token_id);
        let resolved = self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id.clone(), approved_account_ids);
        if before != self.tokens.owner_by_id.get(&token_id) {
            self.bump_epoch(&token_id);
        }
        resolved
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().expect("Contract metadata missing")
    }
}
