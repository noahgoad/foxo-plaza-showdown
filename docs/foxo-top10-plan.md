# FOXO: Plaza Showdown — kế hoạch áp dụng nghiên cứu Top 10

**Goal:** Biến các mode, NFT và kinh tế FOXO hiện hữu thành một trải nghiệm có lý do chơi, quay lại, phối hợp, sáng tạo và chi tiêu rõ ràng; có đường kiểm chứng độc lập từ gameplay tới NEAR Testnet.

**Architecture:** Giữ Three.js client, relay authoritative và các hợp đồng NEAR hiện hữu. Bổ sung event/replay có version, các trang Passport/Guild/Workshop nối chung dữ liệu trận; chỉ đưa quyền sở hữu, nghĩa vụ tài chính và checkpoint lên chain. Media, replay và dữ liệu tìm kiếm nằm ngoài chain, được tham chiếu bằng hash khi cần.

**Tech Stack:** JavaScript/Three.js, Node.js relay, SQLite/libSQL theo cấu hình thực tế, Rust NEAR contracts, NEAR Sandbox, Intear, các adapter social/gas sponsor hiện có.

Ngày: 15/11/2026. Đây là bản kế hoạch đề xuất theo yêu cầu người dùng; chưa sửa gameplay, deploy, tạo campaign hoặc chuyển tiền. Tên chức năng trong game dùng tiếng Anh; tài liệu làm việc dùng tiếng Việt.

## 1. Nền tảng và cách đọc bằng chứng

Đã đọc README, thiết kế kinh tế v2.1, danh sách module trong src/ui, src/economy, server/near và cấu hình package. README dẫn snapshot finalized 277722627 ngày 14/11, có 88 NFT, token FOXO và các hợp đồng Economy/Passport/Pool/Guild/Market. Snapshot này không thay thế kiểm tra chain tại ngày triển khai.

Nguồn nội bộ ưu tiên:
- `README.md`: sản phẩm, đường chơi, snapshot mới và giới hạn đã công bố.
- Tài liệu thiết kế kinh tế FOXO v2.1: ranh giới ngân sách/tài sản/quyền.
- `docs/evidence/foxo-testnet-finalized.json`: bằng chứng ở một thời điểm.
- `config/economy.testnet.json`, `config/economy-deployment-manifest.json`: phải xác minh lại trước thao tác.

Các đường dẫn code trong tài liệu tính từ gốc repository. File ghi **mới** là đề xuất tạo, không phải file đã tồn tại.

## 2. Chọn cấu trúc sản phẩm

Ba hướng đã cân nhắc:
1. Thêm mười nhóm tính năng độc lập theo mười dự án: độ phủ lớn nhưng trải nghiệm phân mảnh, tốn server/art và kiểm thử.
2. Chỉ sửa demo/onboarding: nhanh nhưng chưa xử lý vòng quay lại và nhu cầu chi tiêu.
3. **Chọn: một vòng chơi trung tâm, các hệ thống hiện có hỗ trợ nó.** Trait Hunt là cửa vào; Boss/Control/Trials phục vụ chuyên môn, thử nghiệm và sự kiện; Guild/Passport/Market là phần tiếp nối giữa trận.

Vòng tổng thể:

`Try a Fox → Trait Hunt → khoảnh khắc cướp/chuyển carrier → kết quả + replay + career → chọn mục tiêu nghề/Guild → Boss/Control/Trial → nguyên liệu → craft/equip hoặc giao dịch → chia sẻ/challenge → trận tiếp theo`.

Giữ toàn bộ mode hiện tại. Workshop là màn build, Economy là hub, không quảng cáo hai phần này như hai mode chiến đấu. Không đổi điều kiện thắng Trait Hunt hiện tại chỉ để giống Grand Theft Chog.

## 3. Áp dụng đủ mười dự án, có giới hạn rõ ràng

| Nguồn | Cơ chế chuyển sang FOXO | Gói việc | Phần không sao chép |
|---|---|---|---|
| Grand Theft Chog | Carrier-steal replay, rival rematch tự nguyện, thành tích Guild, thông báo sự kiện trong game | 03, 07, 09 | Cướp tài sản thật; trả token để làm đối thủ yếu hơn |
| CHOG STUDIO | Fox Passport công khai, lịch sử tác giả, ảnh/video highlight từ trận thật | 04, 05 | Dịch vụ AI video trả phí và giọng nói mỗi Fox chưa có nhu cầu xác nhận |
| Chog Hotel | Guild Lounge trưng bày, chủ phòng tổ chức sự kiện, khách vào miễn phí | 08, 09 | Bán rarity để tăng sức mạnh; xây MMO bất động sản mới |
| CHOG GAMES | Party chung các mode, bot practice, daily challenge thống nhất, lịch sự kiện | 02, 09, 10 | Viết lại Monopoly/Poker không liên quan FOXO |
| Chog ToolHub | Player Desk gọn, giao dịch gần đây, quyền đang cấp, hủy/thu hồi/kiểm tra lại | 12, 14 | Sniper/copy trading và quản lý khóa trading |
| DeClub | Mission có người tài trợ, ngân sách escrow, đóng góp có bằng chứng, phân bổ phí minh bạch | 07, 11 | Trả tiền theo số post/like; hứa yield từ volume chưa có |
| The Chog World | Nghề nghiệp, buyer/crafter/fighter phụ thuộc nhau; Guild đặt hàng theo nhu cầu | 06, 07, 11 | Casino, leverage, khóa nghề theo NFT hiếm |
| CHOG//BREAK | Trait Explorer, loadout có nguồn trait, thử A/B, khám phá preset hợp lệ | 05, 06 | Mint con lai, sửa trait Genesis hoặc mặc nhiên trả royalty cho mọi preset |
| chogdown | Giải đấu nhiều vòng, nhịp reveal, bracket theo dõi và spectator | 10 | Vé trả phí/xổ số hoặc phần thưởng lấy từ người thua |
| AMONG CHOGS | Social event có thông tin riêng và lựa chọn đánh lừa, luật dễ kể, practice bằng bot | 10 | Đặt cược bắt buộc; khẳng định server settlement là trustless |

Nguồn để người thực hiện đọc đúng cơ chế:
- https://github.com/ANUBIS-cp/grand-theft-chog và https://grandtheftchog.duckdns.org/fair
- https://chogstudio.xyz/chog/1751 và https://chogstudio.xyz/tv
- https://github.com/boranoyundaa-cmd/chog-town
- https://github.com/danzyot/yot-monopoly
- https://github.com/exsay07/chog-toolhub-hackathon
- https://github.com/nhatquang261002/declub
- https://chog.world và hồ sơ https://chogathon.chog.xyz/dashboard
- https://github.com/Stella112/chog-break
- https://chogdown.vercel.app và hồ sơ dashboard
- https://github.com/UgwujaGeorge/among-chogs

Nguồn tác giả là bằng chứng thiết kế/code được công bố, không phải kiểm toán, doanh thu hoặc nguyên nhân chính thức được giải. Không tự đưa claim retention/doanh thu của họ vào pitch FOXO.

## 4. Ranh giới phải giữ

- Giữ 88 Genesis và supply FOXO hiện tại; không mint mới, đổi metadata hoặc chia lại 900.000 chưa phân bổ.
- 80.000 thưởng trận / 5.000 faucet / 15.000 staking là phân bổ đã chốt, không phải quỹ còn khả dụng. Từng ngân sách mới phải được đối soát và được duyệt trước khi ký.
- Không dùng principal của Pool, escrow mua bán hoặc tiền claim pending cho nhiệm vụ/sự kiện.
- Giá mua cosmetic không tăng sức mạnh PvP. Ranked Trial luôn kit chuẩn. Genesis mang identity/career/customization, không độc quyền khả năng chiến thắng.
- Không coi một ví là một người; anti-abuse phải kết hợp hạn mức, gameplay hợp lệ, rủi ro và điều kiện campaign.
- Trait thật chỉ ánh xạ từ 88 metadata; các đặc tính chưa có model/animation không quảng cáo là đã thể hiện 3D.
- Không phát tiền từ replay, video view, lượt like hoặc practice. Mỗi kết quả thưởng có duy nhất một match ID và phạm vi campaign.
- UI tái sử dụng full-screen subpage, card vũ khí, tab Guild, podium ranking, màu tím/vàng, font, motion và âm thanh game. Không thêm bảng admin vào luồng người chơi.
- Học cơ chế, không chép branding/nhân vật/assets. Nếu tái sử dụng code phải kiểm tra license, giữ thông báo bắt buộc và chỉ lấy phần có test phù hợp.

## 5. Hợp đồng dữ liệu xuyên hệ thống

Định nghĩa mới trong `src/game/foxo-event-schema.js`, validator phía relay import được mà không phụ thuộc DOM.

```js
// Các field bắt buộc của event mới; adapter phải chuyển từ schema hiện hữu.
const event = {
  schemaVersion: 1, rulesVersion: 'foxo-hunt-v1',
  matchId: 'relay-issued-id', seq: 0, tick: 0,
  type: 'carrier_changed', actorSessionId: 'public-session-id',
  payload: { previousCarrier: null, carrier: 'public-session-id', traitCount: 0 }
};
// Không dùng accountId, tokenId hoặc người thắng do browser tự khai làm bằng chứng.
```

Nhóm event: match_started, carrier_changed, trait_collected, support_contribution, boss_phase_changed, objective_scored, match_finished. Manifest gồm build hash, rules hash, map hash, asset version, event digest, kết quả digest, nguồn authoritative/practice. Public participant ID khác session token; không xuất IP, chữ ký đăng nhập, email hoặc chat riêng.

Kết quả finalized tạo ba nhánh độc lập và idempotent: career/material settlement; ranking/mission eligibility; media/replay. Render media lỗi không giữ phần thưởng. RPC timeout không khiến client tự ghi trả thưởng. Danh tính sử dụng NFT được snapshot lúc chấp nhận trận, quyền ở trận mới đọc lại owner/usage epoch.

Replay giai đoạn đầu dùng snapshot authoritative + event để trình diễn; không gọi là deterministic input replay. Khi cần kiểm toán gameplay, lưu input và state hash bổ sung. Chỉ nhận là tái mô phỏng xác định khi cùng version/seed/input cho state hash khớp trên runner kiểm thử.

## 6. Các task triển khai

### 01 — Chốt baseline và đường chơi public

**Sửa:** `README.md`, `server/near-relay.mjs`, `server/cloud/package.json`, `config/economy-deployment-manifest.json` khi có bằng chứng mới. **Mới:** `docs/evidence/foxo-release-matrix.md`.

- [ ] Liệt kê từng chức năng: code/build/browser/Sandbox/Testnet receipt/public; lưu thời điểm và bằng chứng, không dùng một nhãn done chung.
- [ ] Đọc lại code hash/config/balance/paid liabilities ở cùng finalized block; so sánh manifest, không tự upgrade.
- [ ] Kiểm tra public frontend, relay HTTP và WebSocket, login nonce, storage persistence và restart; loại mọi URL tunnel cũ khỏi config phát hành.
- [ ] Benchmark 1 phòng rồi 2 phòng đủ 6 slot, gồm bot; đo CPU/RAM, tick p95, kết nối lại. Trần thử: p95 tick processing dưới tick interval, backlog không tăng suốt 10 phút.
- [ ] Nếu gói host không đạt: giới hạn concurrency và queue rõ ràng; không tuyên bố ping làm tăng CPU hay đảm bảo uptime.

### 02 — Guided first match và Party

**Sửa:** `src/ui/hunt-menus.js`, `src/ui/hunt-match-ui.js`, `src/ui/near-wallet-ui.js`, `src/ui/objective-mode-ui.js`. **Mới:** `src/ui/foxo-onboarding.js`, `tools/near/foxo-onboarding.test.mjs`.

- [ ] Guest có Try a Fox, preview trait và practice; không ép ký ví trước khi thử.
- [ ] Tutorial 60–90 giây chỉ dẫn di chuyển → carrier → chuyển carrier → mục tiêu thắng; có skip và replay hướng dẫn.
- [ ] Kết thúc practice hiện Play again, Invite friend, View Fox; không hiển thị số FOXO có thể rút.
- [ ] Party giữ tên/avatar và code qua chọn mode; chặn chuyển mode khi trận hoặc giao dịch đang được quyết toán.
- [ ] Chuyển guest sang wallet giữ lựa chọn cosmetic tương thích, không chuyển practice XP thành career onchain.

### 03 — Trait Hunt rõ vai trò, rival và replay

**Sửa:** `src/game/hunt-core.js`, `src/game/hunt-runtime.js`, `src/ui/hunt-hud.js`, `server/near/result-adapter.mjs`. **Mới:** `src/game/foxo-event-schema.js`, `server/near/replay-service.mjs`, `src/ui/foxo-replay-ui.js`, `tools/near/foxo-replay.test.mjs`.

- [ ] Ghi event khi đổi carrier/nhặt trait/kết thúc; seq tăng, payload có giới hạn kích thước.
- [ ] HUD cho biết carrier hiện tại, bộ trait đã gom và ai vừa kế thừa; giữ nguyên luật thắng hiện tại.
- [ ] Chọn highlight theo rule: chuyển carrier sau khi có ít nhất 2 trait; lần đảo vai cuối; hoàn thành mục tiêu. Không dựng lại tình huống chưa xảy ra.
- [ ] Xuất replay snapshot 5 Hz + các event quan trọng; spectator nội suy, không dùng snapshot này để tính lại tiền thưởng.
- [ ] Link replay mở spectator không cần ví; hash/manifest không khớp thì từ chối verified badge.
- [ ] Rival rematch là lời mời riêng tự nguyện; không phát thêm thưởng cho giao dịch/đấu dàn xếp giữa cùng hai người.

### 04 — Highlight Studio từ gameplay thật

**Mới:** `src/ui/foxo-highlight-ui.js`, `server/near/highlight-manifest.mjs`, `tools/near/foxo-highlight.test.mjs`. **Sửa:** `src/ui/hunt-match-ui.js`, `src/ui/near-passport-ui.js`.

- [ ] Chọn clip 8–15 giây quanh highlight, xuất khung 16:9/9:16 hoặc ảnh kết quả.
- [ ] Hiện Fox, tác giả trận, mode, mùa và link replay. Practice có nhãn Practice; demo rút ngắn có nhãn riêng trong trang bằng chứng.
- [ ] Render cục bộ ưu tiên để tránh tạo chi phí server; người dùng bấm tải/chia sẻ, không tự post.
- [ ] Ưu tiên kết quả chiến thuật, không tự ghép lời thoại/claim doanh thu bằng AI.

### 05 — Passport, Trait Explorer và provenance

**Sửa:** `src/ui/near-passport-ui.js`, `src/ui/near-collection-browser.js`, `server/near/passport-routes.mjs`, `server/near/career-record.mjs`, `server/near/usage.mjs`. **Mới:** `src/ui/foxo-trait-explorer.js`, `config/foxo-trait-affinities.v1.json`, `tools/near/foxo-trait-explorer.test.mjs`.

- [ ] Tạo trang Fox gồm Identity, Career, Loadout, Highlights; công khai có chọn lọc, dữ liệu riêng không bị lộ.
- [ ] Mỗi trait giải thích ngắn: nguồn metadata → lựa chọn skill → trade-off → mode áp dụng.
- [ ] Compare A/B hai Fox hoặc hai preset: hiện khác biệt thực tế, nút Try in practice.
- [ ] Giữ tác giả lịch sử khi Fox bán/mượn; thay owner không biến người mua thành người đạt thành tích.
- [ ] Portfolio cosmetic chỉ hiển thị item còn quyền equip; account-owned item không tự đi theo Fox khi bán.

### 06 — Workshop discovery và nghề chế tạo

**Sửa:** `src/ui/boss-raid-ui.js`, `src/economy/specializations.js`, `src/ui/near-profession-ui.js`, `src/ui/near-crafting-ui.js`, `server/near/professions.mjs`. **Mới:** `src/game/foxo-preset-discovery.js`, `config/foxo-preset-recipes.v1.json`, `tools/near/foxo-preset-discovery.test.mjs`.

- [ ] Giữ ngân sách skill 5 điểm; affinity từ NFT gợi ý cách build, không tự thêm damage/quota.
- [ ] Khởi tạo 6 preset được đặt tên từ tổ hợp effect/target/modifier đã hỗ trợ; không phát minh effect runtime chưa có.
- [ ] Màn reveal cho biết từng thành phần, nguồn mở khóa và đánh đổi; discovery cho badge/career, không tạo một token mới.
- [ ] Mỗi nghề có tiến độ license, nhiệm vụ tiếp theo, recipe preview và Try look; thành tích được relay xác minh.
- [ ] Test cùng preset trên Fox thường/hiếm cho cùng budget và hệ số; thay balance chỉ áp trận mới theo version.

### 07 — Guild missions kết nối cả chơi và sản xuất

**Sửa:** `server/near/guild-missions.mjs`, `server/near/guild-mission-rewards.mjs`, `server/near/guilds.mjs`, `src/ui/near-guild-ui.js`, `src/economy/near-guild.js`. Contract chỉ sửa sau gap audit: `contracts/near-guild/src/lib.rs`, `contracts/near-economy/src/lib.rs`.

- [ ] Mỗi mission có mode/rules version, contribution rule, expiry, ngân sách đã khóa, reward cap, cancellation policy và trạng thái settled/refunded.
- [ ] Ba mẫu đầu: Boss squad clear; Control objective contribution; craft/deliver cosmetic theo Guild project. Hunt mission dùng mục tiêu/carrier thực, không dùng số kill thô.
- [ ] Chặn claim mission trùng bằng missionId + account + match/result ID; chỉ cấp từ kết quả đủ điều kiện và không phải practice.
- [ ] UI hiện đồng thời progress, nguồn reward, người tài trợ và phần còn lại; hết quỹ vẫn chơi được nhưng không gán nhãn có thưởng.
- [ ] Guild rival challenge không đánh cắp escrow/material của Guild khác. Mỗi bên tự nguyện vào sự kiện.

### 08 — Guild Lounge và nhu cầu trưng bày

**Mới:** `src/ui/foxo-guild-lounge.js`, `src/world/foxo-guild-display.js`, `server/near/guild-lounge.mjs`, `tools/near/foxo-guild-lounge.test.mjs`. **Sửa:** `src/ui/near-guild-ui.js`, `src/ui/near-guild-directory.js`.

- [ ] Dùng không gian plaza hiện hữu: bảng Guild, banner, trophy, ảnh Fox và màn replay; không xây map MMO mới.
- [ ] Owner/officer sắp xếp layout từ 3 mẫu cùng bộ slot cố định; kiểm tra quyền cả server và UI.
- [ ] Khách vào xem miễn phí, tham gia sự kiện qua party; công khai lịch và lịch sử hoạt động đã xác minh.
- [ ] Catalogue mới giai đoạn này chỉ gồm cosmetic thực sự có preview/runtime: banner, trophy display, replay frame. Tách đồ trang trí thuê thời hạn khỏi item sở hữu vĩnh viễn.
- [ ] Không tạo thành viên/điểm/raid giả cho 5 Guild mẫu; nếu giữ seed demo phải hiện Demo và nằm ngoài ranking/reward.

### 09 — Sự kiện cộng đồng và quay lại

**Mới:** `server/near/community-events.mjs`, `src/ui/foxo-event-ui.js`, `config/foxo-community-events.v1.json`, `tools/near/foxo-community-events.test.mjs`. **Sửa:** `src/ui/objective-mode-ui.js`, `src/ui/hunt-menus.js`.

- [ ] Lịch tuần gồm một Hunt rematch event, một Boss squad event và một Daily Trial chung seed; reward mặc định bằng 0 trừ campaign đã nạp.
- [ ] Nhắc trong game theo opt-in; không gửi email/X/Discord/Telegram tự động khi chưa có quyền tích hợp.
- [ ] Thông báo dẫn thẳng tới party/event; không ưu tiên trả tiền trong matchmaking.
- [ ] Guild board và recap dẫn tới replay thật; có report/hide, giới hạn spam và rate limit.

### 10 — Hai biến thể sự kiện có phạm vi kiểm soát

**Mới:** `src/game/foxo-event-rules.js`, `server/near/event-bracket.mjs`, `tools/near/foxo-events.test.mjs`. **Sửa:** `src/ui/near-ranking-ui.js`, `src/ui/objective-mode-ui.js`.

**Plaza Cup:** bracket 8 người/đội tùy mode, không vé trả phí; vòng dùng luật mode có sẵn. Một sự kiện khóa mode, seed policy và loadout policy trước đăng ký; default demo là 8 người Daily Trials cùng 3 lượt seed, tổng thời gian hợp lệ thấp nhất thắng. Disconnect được đánh dấu DNF, hòa dùng lượt hợp lệ tốt nhất rồi thời điểm hoàn thành, không random tiền thưởng. Bot chỉ có bracket practice riêng.

**Decoy Hunt:** biến thể social của Hunt, không mode kinh tế mới. Một carrier thật; hunter có thể dùng decoy marker thời hạn ngắn và có cooldown cố định. Thông tin thật chỉ gửi cho role được phép; server quyết định ai là carrier. Không bầu/đặt cược, không sinh thêm FOXO. Bản đầu private practice; muốn reward phải có rubric riêng qua audit.

- [ ] Triển khai bracket/read-only spectator rồi mới nối campaign có ngân sách hữu hạn.
- [ ] Test DNF, reconnect, tie, rematch, quá giờ và giới hạn đăng ký.
- [ ] Test packet spectator không lộ hidden role/decoy truth khi trận đang chạy; replay đầy đủ chỉ công khai sau trận.
- [ ] Ghi nhận thời gian học luật và tỷ lệ hiểu nhầm trước khi đưa biến thể vào menu public.

### 11 — Người mua cuối, Quartermaster và dòng tiền

**Sửa:** `server/near/quartermaster-policy.mjs`, `server/near/quartermaster-orders.mjs`, `server/near/quartermaster.mjs`, `src/economy/near-orders.js`, `src/ui/near-orders-ui.js`, `config/economy.testnet.json` sau duyệt. **Mới:** `server/near/economy-demand-ledger.mjs`, `tools/near/economy-demand-ledger.test.mjs`.

- [ ] Gắn order với Guild project hoặc cosmetic demand có người cấp quỹ; không để NPC mua vô hạn chỉ để tạo volume.
- [ ] Tách thống kê external spend, P2P gross, platform fee, sponsored spend, principal, reward liabilities và material consumption.
- [ ] Giữ phí hiện hành cho tới khi đối chiếu contract; không tự thêm chia doanh thu hay burn theo phần trăm từ dự án khác.
- [ ] Quartermaster đề xuất quantity/price theo nhu cầu còn thiếu và ngân sách; execution chỉ qua policy allowlist + hạn mức + quyền đã duyệt.
- [ ] NEAR AI chỉ hỗ trợ văn bản nhiệm vụ hoặc đề xuất kế hoạch mua trong schema; output lỗi dùng template. Model không quyết định thắng, không tự ký hoặc cấp thưởng.
- [ ] Những vật phẩm không có runtime/equip không được đưa vào lệnh mua tài trợ.

**Bất biến:** `spendable = confirmed balance - principal - escrow - pending claims - other reserved liabilities`. Giá trị âm khóa thao tác chi mới, giữ đường claim/khôi phục hợp lệ. Mọi budget nằm trong tài khoản tương ứng, không chỉ một con số dashboard.

### 12 — Player Desk và hai chợ

**Sửa:** `src/ui/near-economy-page.js`, `src/ui/near-market-ui.js`, `src/ui/near-sales-ui.js`, `src/ui/near-market-card.js`, `src/ui/near-orders-ui.js`, `src/ui/near-loans-ui.js`.

- [ ] Economy hub có Wallet & Activity, Crafting, Cosmetics, Fox Market, Guild, Orders; mỗi mục là subpage có đường Back rõ.
- [ ] Market có grid, ảnh thật, filter, search, sort, trạng thái sở hữu/listed, giá, fee và detail panel; không bắt người mua biết sale ID.
- [ ] Player Desk gom pending transaction, claimable, funds available to withdraw, usage grants và pending order. Không gọi tiền contract giữ là số dư wallet.
- [ ] Với mỗi action có source contract, tổng chi phí, quyền bị thay đổi và kết quả pending/confirmed/failed. Các trường kỹ thuật thu gọn trong Details.
- [ ] Thao tác revoke usage/cancel order có preview ảnh hưởng; không xóa giao dịch pending khi refresh.

### 13 — NEAR: nâng cấp tối thiểu và bằng chứng deploy

**Sửa khi cần:** `contracts/near-passport/src/lib.rs`, `contracts/near-economy/src/lib.rs`, `contracts/near-guild/src/lib.rs`; `contracts/near-economy/sandbox/economy.test.mjs`, `ranking.test.mjs`, `sales.test.mjs`; adapter `server/near/career-chain.mjs`, `transaction-transport.mjs`.

- [ ] Gap map từng trường mới vào storage/event hiện có. Replay/public page không tự cần contract mới.
- [ ] Passport checkpoint lưu reference/hash/version nếu schema hiện tại chưa đủ; không lưu video onchain.
- [ ] Guild campaign/order chỉ nâng cấp nếu không biểu diễn được bằng primitives đang có; giữ schema cũ và migration có test dữ liệu thực tương đương.
- [ ] Kiểm thử callback lỗi, insufficient storage, transfer trong trận, entitlement trùng, migration và restart outbox trong Sandbox.
- [ ] Chuẩn bị manifest Wasm hash/ABI/config/state invariants và giao dịch chưa ký; người dùng ký bước upgrade/funding.
- [ ] Sau ký đọc finalized outcome, code hash/config, balances và NFT supply; canary giá trị nhỏ rồi mới bật rollout.

### 14 — Social onboarding, gas và quyền

**Sửa:** `src/ui/near-wallet-ui.js`, `server/near/social-wallet.mjs`, `server/near/social-verifier.mjs`, `server/near/gas-sponsor.mjs`, `gas-sponsor-dispatch.mjs`, `src/economy/near-pool-sponsorship.js`.

- [ ] Kiểm thử callback public thật, popup trả về đúng origin/state, giữ WebGL game đang chạy.
- [ ] Nếu social chưa tạo ví chain được thì hiển thị đúng social profile và bước Link wallet; không giả có NFT/wallet balance.
- [ ] Nếu triển khai ví cho social: hiển thị cách recovery/export và mô hình giữ khóa trước tạo account; không gửi private key qua log/client analytics.
- [ ] Gas sponsor có allowlist method, per-account/IP/campaign cap, expiry và replay protection; không tài trợ transfer tùy ý.
- [ ] Chứng minh ít nhất một sponsored receipt thật bằng account đủ điều kiện; hết ngân sách cho lựa chọn tự trả gas, không lặp popup.

### 15 — Đo trải nghiệm và kinh tế

**Mới:** `server/near/product-telemetry.mjs`, `tools/near/foxo-cohort-report.mjs`, `docs/evidence/foxo-product-metrics.md`.

- [ ] Funnel: landing → interactive → tutorial started/completed → match started/completed → second match → optional wallet → economy action.
- [ ] Tách guest/holder, practice/reward, human/bot, demo/real; không dùng lượt bot để báo retention.
- [ ] Đo time-to-first-action, time-to-first-highlight, quit point, rematch, D1/D7, share open→play; báo số mẫu cạnh tỷ lệ.
- [ ] Đo người mua độc lập, repeat buyer, số item equip sau mua, sponsor dependence, net liability và order fill thực.
- [ ] Không phát thưởng vì telemetry, không lưu email/wallet raw vào public dashboard; retention log có policy xóa sau 30 ngày trong pilot.

**Gate sản phẩm đề xuất:** trong 10 người thử mới, ít nhất 8 hoàn thành tutorial không được hướng dẫn trực tiếp, ít nhất 6 mô tả đúng tác dụng trait. Đây là mục tiêu thử nghiệm, không số liệu đã đạt và không thay thế đo retention dài hạn.

### 16 — Release và demo có thể kiểm chứng

**Mới:** `tools/near/foxo-release-audit.mjs`. **Sửa:** `README.md`, các trang bằng chứng public hiện có.

- [ ] Public entry có Play, Watch a real match và Inspect Testnet evidence; CTA không dẫn tới localhost.
- [ ] Quay một chuỗi: Try → Hunt carrier steal → replay → Passport trait/provenance → Workshop A/B → Guild funded objective → craft/equip → market → finalized receipt.
- [ ] Trận rút ngắn chỉ để minh họa, gắn practice/demo; dùng giao dịch thật riêng làm bằng chứng settlement, không lấy fixture làm thành tích thật.
- [ ] Chạy lại build/check và test thay đổi; smoke menu/4 mode/craft/2 markets/Guild/ranking trên bản deploy.
- [ ] Thử hai account cho transfer/sale/loan/permission và một payout thực. Nếu chưa có account/ủy quyền phù hợp, ghi gate blocked với đúng tác vụ cần người dùng ký, không báo toàn bộ đã xong.
- [ ] Rollback feature flag UI/client khi lỗi; không rollback nghĩa vụ tài chính bằng cách deploy code cũ mù quáng.

## 7. Thứ tự, phụ thuộc và phạm vi phát hành

| Đợt | Task | Kết quả độc lập có thể dùng | Gate |
|---|---|---|---|
| A — nền tảng | 01–02 | Public chơi được, người mới hiểu game | Health/persistence/first match |
| B — bản sắc | 03–06 | Hunt có replay, Fox có career, trait có thể thử | Event integrity + runtime comparison |
| C — cộng đồng | 07–09 | Guild có mục tiêu, địa điểm, sự kiện | Funding/rights + UI full flow |
| D — hoạt động lặp lại | 10 | Cup và Decoy practice | Rules/hidden info + comprehension |
| E — kinh tế và quyền | 11–14 | Chi tiêu/giao dịch/auth có nguồn và giới hạn | Sandbox + user signing + finalized canary |
| F — kiểm chứng | 15–16 | Cohort và demo dựa bằng chứng thật | Release matrix không còn mục mập mờ |

Task 15 instrument từ A, không chờ F. Task 13 gap audit bắt đầu cùng B nhưng chỉ upgrade sau Sandbox. Task 14 có thể độc lập với phần replay. Task 12 thực hiện cùng từng màn tương ứng, không để UI tới cuối.

Nếu được phép dùng subagent khi triển khai: lane gameplay 03/06/10; lane UI/media 02/04/05/08/12; lane relay/contracts 07/11/13/14; người tích hợp giữ 01/15/16. Khóa ownership theo file, tách integration ở near-relay; không để nhiều agent cùng sửa file UI lớn hoặc cùng chuẩn bị giao dịch.

Ước lượng sơ bộ theo code đã xem, không phải cam kết: A 2–4 ngày công; B 6–10; C 6–10; D 4–7; E 6–10; F 3–5, tổng 27–46 ngày công. Tái sử dụng đúng module có thể rút ngắn; lỗi auth provider, host và wallet approval có thể kéo dài. Một release lõi A+B có giá trị trước khi xong toàn bộ, nhưng không đổi nhãn toàn bộ plan thành hoàn tất.

## 8. Kiểm thử và lệnh baseline

Chạy từ gốc game, không từ repo cha:

```powershell
npm run check
npm run build
node --test tools/near/near-quickplay.test.mjs tools/near/career-chain.test.mjs tools/near/guild-mission-rewards.test.mjs
```

Kỳ vọng exit code 0, không lỗi syntax/build, các test liên quan PASS. Đây là lệnh từ cấu trúc hiện tại, chưa chạy lại trong lượt lập kế hoạch.

Mỗi module logic mới có file test đã chỉ định tại task; chạy `node --test <đường dẫn file test>` trước/sau sửa. Không viết test sao chép CSS; UI cần ảnh/runtime tại viewport thật và từng trạng thái. Sandbox dùng runner hiện hữu `contracts/near-economy/sandbox/run.ps1`, đọc tham số của runner trước chạy; không tự thay sandbox version chỉ để làm test xanh.

Ma trận lỗi bắt buộc: RPC 429/timeout; FT callback fail; relay restart trước/sau broadcast; user hủy ký; wallet switch; NFT transfer giữa trận; listing/loan conflict; hết reward reserve; hết sponsor reserve; social callback sai origin; asset thiếu; WebGL context lost; public replay bị sửa bytes; hidden role bị request trái quyền.

## 9. Quyết định tài chính phải trình riêng khi triển khai

Plan không tự duyệt giá/campaign mới. Trước thao tác dùng tiền cần một bản review có: account trả, receiver, amount atomic/hiển thị, purpose, nguồn reserve, expiry, hạn mức, refund, principal/liability trước và sau, Wasm hash nếu upgrade.

Mặc định event mới reward = 0; Quartermaster không vượt quỹ đang được duyệt. Giá cosmetic mới chỉ xuất hiện để bán sau khi asset/equip và quyền sở hữu đã qua test. Không đưa AI movie generation trả phí, royalty cho preset, paid tournament ticket hoặc staking yield mới vào bản release này.
