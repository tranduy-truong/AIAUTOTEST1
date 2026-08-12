# Playwright & Vitest AI Automation Test Toolkit

Bộ công cụ hỗ trợ lên kế hoạch và sinh mã nguồn kiểm thử tự động (E2E, Integration, Unit) sử dụng AI, tích hợp Playwright và Vitest.

---

## 🛠️ Hướng dẫn cài đặt nhanh (Clone & Run)

Dự án đã được cấu hình sẵn các file script tự động hóa môi trường. Mentor/Tester sau khi clone về chỉ cần chạy lệnh sau:

### 1. Khởi tạo môi trường
- **Trên Windows**: Click đúp vào file `setup.bat` (hoặc chạy trong cmd: `setup.bat`).
- **Trên macOS / Linux**: Chạy lệnh `./setup.sh` trong Terminal.

*Script này sẽ tự động:*
- Cài đặt toàn bộ dependencies trong `package.json`.
- Cài đặt trình duyệt chạy Playwright (`npx playwright install`).
- Khởi tạo file cấu hình môi trường `.env` từ `.env.example`.
- Tạo các thư mục test cần thiết.

### 2. Cấu hình khóa API Key
Mở file `.env` vừa được tạo ra ở thư mục gốc và điền API Key của bạn:
```env
GROQ_API_KEY=your_api_key_here
```

---

## 🚀 Hướng dẫn chạy chương trình

### 1. Bật bảng điều khiển CLI chính
Chạy lệnh sau ở thư mục gốc để mở Menu tương tác:
```bash
npm start
```

### 2. Chạy test case thủ công (Playwright)
Để chạy các file kiểm thử E2E đã sinh ra:
- Chạy headless (không giao diện):
  ```bash
  npx playwright test
  ```
- Chạy headed (hiển thị trình duyệt):
  ```bash
  npx playwright test --headed
  ```
- Chạy với giao diện Playwright UI trực quan:
  ```bash
  npx playwright test --ui
  ```

---

## 📁 Cấu trúc thư mục dự án

```text
├── src/                  # Mã nguồn CLI và các AI Agents (Planner, Generator, Crawler)
├── tests/
│   ├── e2e/              # Nơi chứa các file test Playwright (.spec.ts)
│   ├── integration/      # Nơi chứa test tích hợp API/DB
│   └── unit/             # Nơi chứa unit test logic nội bộ
├── artifacts/            # Báo cáo phân tích lỗi và DOM Crawl
├── playwright.config.ts  # Cấu hình Playwright
├── package.json          # Khai báo thư viện dependencies
├── setup.bat             # File cài đặt tự động cho Windows
└── setup.sh              # File cài đặt tự động cho macOS/Linux
```

## Luồng E2E hiện tại

1. **Planner** đọc trực tiếp kịch bản tiếng Việt, tách câu ghép thành Action Intent nguyên tử và ghi `artifacts/test-plan-e2e.json`. File Markdown cùng tên chỉ là bản trình bày được dựng tự động từ JSON.
2. **Validator của Planner** chặn test case/bước/dữ liệu không có trong kịch bản, bước mơ hồ và mọi locator do AI tự tạo. Kịch bản lớn được chia theo `TC_...` để tránh vượt giới hạn token rồi mới hợp nhất.
3. **Live Crawler** chạy các Action Intent trên website thật. Locator tự xác minh được lưu vào Action Plan; trường hợp chưa biết mới yêu cầu tester chọn mẫu và ghi nhớ nội bộ trong `.testkit/crawler-locators.json`.
4. **Generator** chỉ sinh Playwright từ `artifacts/action-plan.json` đã xác minh. Nó không được thay locator hoặc đổi Expected Result.
5. **Healer** khi test lỗi sẽ replay lại `test-plan-e2e.json`, crawl trạng thái thật và chỉ sửa phần kỹ thuật nếu vẫn giữ nguyên kết quả mong đợi.

`source-script-e2e.md` là đầu vào gốc để đối chiếu; `test-plan-e2e.json` là dữ liệu chuẩn cho máy; `test-plan-e2e.md` là bản dễ đọc cho tester; `crawled-dom.md` là catalog DOM rút gọn; `action-plan.json` là hợp đồng cuối giữa Crawler và Generator.

## Luồng Unit Test Whitebox

Kiến trúc công khai vẫn là **Planner → Generator → Healer**. Code Reader, Branch Analyzer và Dependency Resolver nằm trong `src/core/unit/`, là công cụ nội bộ của Planner chứ không phải agent thứ tư.

### Phạm vi phiên bản hiện tại

- Dự án JavaScript/TypeScript đã cấu hình Vitest hoặc Jest.
- Hàm/arrow function được `export`; class export được tách thành từng public method để mỗi target có đúng async/input/branch/dependency riêng.
- Phân tích `if/else`, ternary, `switch`, `catch` và vòng lặp bằng TypeScript AST.
- Phân loại dependency database/API/filesystem/process/time và global `fetch`, đồng thời ghi `usedMembers` để Generator biết chính xác operation cần mock.
- Testability Classifier gán một trong 8 profile cho từng target: `UNIT_NATIVE`, `UNIT_MOCKED`, `COMPONENT_DOM`, `INTEGRATION_SANDBOX`, `PROCESS_SANDBOX`, `ENTRYPOINT_SMOKE`, `NO_RUNTIME_TEST`, `REFACTOR_REQUIRED`.
- Dựng call graph/type graph có giới hạn để cung cấp đúng helper, constant và interface reachable; không kéo dependency của hàm không liên quan.
- Test sinh tại `<du-an-dich>/tests/unit/ai-generated/` và luôn import source thật.
- Planner ưu tiên dựng **Test Intent JSON** trực tiếp từ AST. Khi tester không nhập requirement bổ sung và AST đủ hợp đồng, hệ thống bỏ qua AI hoàn toàn. AI chỉ được dùng để diễn giải business requirement hoặc bổ sung target mà deterministic planner chưa dựng được.
- Output AI hỏng JSON, bị cắt, sai hợp đồng hoặc API lỗi không còn chặn batch: parser lấy object JSON cân bằng nếu có; nếu vẫn không dùng được, Planner quay về AST deterministic. Lỗi AI chỉ được lưu trong `planner-ai-diagnostics.json`.
- AI không viết import, `vi.mock`, constructor, invocation hay assertion; Generator chỉ nhận Test Intent JSON đã xác minh.
- Generator dùng deterministic compiler dựa trên TypeScript Compiler API để dựng file Vitest. Vì cấu trúc code do hệ thống tạo nên không còn vòng “AI sinh file → hàng chục lỗi static → gọi AI sửa lại”.
- File sinh vẫn phải qua static contract, TypeScript preflight và chạy bằng runner thật; phiên chạy chỉ giữ file của lần Generator thành công gần nhất.
- Generator dung lỗi theo test case và target: case thiếu oracle/mock được ghi `NEEDS_ORACLE`/`INVALID_MOCK`, các case hợp lệ vẫn được sinh. Một target lỗi/không có sandbox không chặn target khác; trạng thái nằm trong `generation-manifest.json` và `untestable-targets.json`.
- Oracle Resolver không tin trực tiếp expected do AI đề xuất. Expected chỉ được biên dịch khi có đoạn requirements của tester làm bằng chứng, static evaluator chứng minh được từ AST thuần, hoặc mock-trace chứng minh được qua dependency behavior có cấu trúc. Mock-trace mô phỏng `return/throw/resolve/reject`, `try/catch`, `await` và call sequence nhưng không gọi network/filesystem/process thật. Quan sát sandbox chỉ được gắn nhãn characterization. Bằng chứng từng case nằm trong `oracle-resolution.json`; các điểm cần tester xác nhận được tách riêng trong `oracle-requests.json`.
- Khi dự án có coverage provider, runner ép xuất `coverage-final.json`, ánh xạ gap về branch ID/dòng nguồn và chạy tối đa 3 vòng Planner → Generator bổ sung. Vòng lặp dừng nếu coverage không tăng; đặt `UNIT_COVERAGE_LOOP=0` để tắt.
- Healer Unit chạy theo chính sách `diagnose-only`: không đổi expected, không sửa source sản phẩm và không skip test.

### Cách dùng

1. Chạy `npm start`.
2. Chọn `AI Lên kế hoạch & Sinh Code Test` → `Unit`.
3. Chọn thư mục dự án, một file nguồn hoặc dán một đoạn code có `export`.
4. Chọn hàm hoặc `Class.method` cần test và nhập requirement nếu có.
5. Planner AST lập Test Intent cho từng target; AI chỉ bổ sung khi cần. Generator deterministic biên dịch JSON đã xác minh thành test.
6. Chọn `Chạy kiểm thử Unit Test` ở menu để chạy các file gần nhất trong đúng thư mục dự án đích.

TestKit không tự cài test runner và không gửi `.env`, secret key, test cũ, `node_modules`, `dist`, `build` hoặc `coverage` vào AI. Deterministic compiler hiện hỗ trợ Vitest; dự án Jest được báo `PROFILE_NOT_SUPPORTED` cho tới khi có Jest compiler adapter riêng.

### Artifact của mỗi lần chạy

```text
artifacts/unit/<project>/<yyyyMMdd_HHmmss_SSS>/
├── project-manifest.json
├── testability-manifest.json
├── target-partitions.json
├── code-index.json
├── branch-map.json
├── dependency-map.json
├── supporting-context.json
├── context-bundle.json
├── test-plan-unit.json
├── test-plan-unit.md
├── planner-ai-diagnostics.json (chỉ có khi AI/fallback cần ghi chẩn đoán)
├── generation-manifest.json
├── test-results.json
├── coverage-gaps.json
├── coverage-loop.json
├── untestable-targets.json
└── healer-diagnosis.json
```

JSON là hợp đồng cho chương trình; Markdown là bản trình bày để tester đọc. `supporting-context.json` chứa call graph, helper, type và constant thật sự liên quan đến target. `sourceHash` chặn Generator nếu target hoặc supporting source đã thay đổi sau khi Planner lập kế hoạch.

`INTEGRATION_SANDBOX` và `ENTRYPOINT_SMOKE` hiện được inventory nhưng chỉ sinh khi dự án khai báo sandbox/startup harness an toàn; hệ thống không tự kết nối database thật hoặc khởi động server thật. `NO_RUNTIME_TEST` là kết quả hợp lệ cho file chỉ chứa type/interface/constant tĩnh, không phải lỗi bị bỏ sót.
