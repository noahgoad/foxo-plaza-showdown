# Khung thông báo vai trò Chog — v1

Bộ asset được tạo bằng công cụ image_gen tích hợp. Các PNG giữ nguyên alpha của bản sinh; không có chữ, tên người chơi, mã NFT, ảnh nhân vật hay icon trait được in cố định.

## Các lớp

| File | Công dụng |
|---|---|
| board.png | Một nền bảng duy nhất cho cả người đi săn và người bị truy tìm. Giữ nguyên tỷ lệ 1295 × 1215. Phần ngoài silhouette trong suốt, phần trong là nền đỏ. |
| image-frame.png | Viền vuông rỗng dùng cho ảnh NFT và các ô trait. Cả giữa và bên ngoài đều trong suốt. |
| nameplate.png | Vệt sơn tím đen rỗng đặt sau tên người chơi, mã NFT hoặc tên trait. |
| title-backing.png | Vệt sơn trắng ngà rỗng đặt sau chữ tiêu đề màu đen. |

Hai vai trò phải tham chiếu cùng file board.png, không tạo nền riêng hay kéo giãn nền để đổi vai trò.

## Ghép nội dung động

Thứ tự từ dưới lên: board → nền vùng nội dung → ảnh/icon → image-frame → các dải sơn → chữ thật của giao diện.

- Bảng WANTED: tiêu đề, ảnh mục tiêu, tên người chơi và mã NFT. Không hiển thị trait, map hay thời gian.
- Bảng người bị truy tìm: YOU ARE THE TARGET, FIND ALL 4 TRAITS, lưới 2 × 2 gồm icon và tên trait cần tìm. Không hiển thị ảnh nhân vật, tên người chơi hay mã NFT.
- Dữ liệu ảnh, tên, NFT và bộ trait phải nhận từ trạng thái trận hiện tại. Không đọc chúng từ hình demo và không cố định #1462 trong asset/template.
- Chữ dùng lớp DOM/Canvas riêng; tên dài giảm cỡ chữ hoặc xuống dòng trong vùng tên, không kéo giãn khung.
- Đặt ảnh sau image-frame, ở khoảng inset 14% mỗi cạnh của khung ảnh để ảnh không tràn ra ngoài mép sticker. Dùng object-fit: cover cho ảnh chân dung; contain cho icon trait.
- Có thể thêm nền tím bằng CSS/Canvas sau ảnh trait để đồng bộ bản demo; không cần tạo PNG cho từng NFT hoặc mỗi bộ trait.

## Vùng đặt nội dung gợi ý

Tọa độ theo tỷ lệ 0–1 của toàn bảng, dùng tâm vùng để định vị. Đây là vị trí khởi đầu để ghép giao diện, không phải nội dung đã raster hóa.

| Vai trò | Vùng | Tâm x/y | Rộng/cao |
|---|---|---|---|
| WANTED | Tiêu đề | .50 / .28 | .66 / .17 |
| WANTED | Ảnh + khung | .50 / .56 | .45 / .48 |
| WANTED | Tên người chơi | .50 / .83 | .61 / .12 |
| WANTED | Mã NFT | .50 / .91 | .45 / .065 |
| Target | Hai dòng tiêu đề | .50 / .30 | .66 / .20 |
| Target | FIND ALL 4 TRAITS | .50 / .45 | .58 / .09 |
| Target | Ô trait 1, 2 | .36,.64 / .60 | .25 / .267 |
| Target | Ô trait 3, 4 | .36,.64 / .80 | .25 / .267 |

Khung ảnh vuông cần giữ tỷ lệ theo pixel; tỷ lệ chiều cao trong bảng có bù aspect ratio của board. Nhãn trait có thể nằm chồng lên mép dưới của khung ảnh trên một nameplate nhỏ.

## Kiểm tra file

Cả 4 PNG đều là RGBA, có alpha từ 0 đến 255 và góc ngoài hoàn toàn trong suốt. Tâm image-frame cũng trong suốt. Kích thước và file nguồn được ghi trong manifest.json. Prompt đầy đủ nằm trong generation-prompts.json.

Đây là bộ asset rỗng và hướng dẫn ghép lớp; ảnh demo trước đó chỉ là tài liệu tham khảo bố cục.
