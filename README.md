# Robo English (Flask + AI chấm điểm)

## 1) Giới thiệu
Robo English là ứng dụng web học tiếng Anh theo chủ đề (Lớp 1 → Lớp 5) gồm các phần: học từ vựng, luyện nói, luyện viết, kiểm tra. Ứng dụng sử dụng một số kỹ thuật “AI” để **chấm mức độ đúng** (đặc biệt cho phần nói/viết câu), **đưa gợi ý sửa**, và **ghi lại lịch sử học tập**.

## 2) Cấu trúc dự án
- [app.py](app.py): Backend Flask, dữ liệu giáo trình, API chấm điểm/AI, TTS, chatbot, phiên âm, lưu lịch sử.
- [templates/index.html](templates/index.html): Giao diện chính.
- [static/app.js](static/app.js): Logic frontend (render bài, gọi API, tính điểm theo topic).
- [static/styles.css](static/styles.css): CSS bổ trợ.
- [learning_history.json](learning_history.json): Lưu lịch sử làm bài (đúng/sai, điểm, ngữ cảnh, question_id…).

## 3) Quy trình tạo ra (tổng quan)
Quy trình xây dựng dự án có thể hiểu theo các bước:
1. **Thiết kế giáo trình**: Tạo dữ liệu theo cấu trúc `CURRICULUM` (lớp → topic → vocab/quiz/grammar) trong backend.
2. **Thiết kế trải nghiệm học**: Chia thành 4 tab chính:
   - Học Từ Vựng (nghe phát âm)
   - Luyện Nói (micro + chấm AI)
   - Luyện Viết (viết từ / viết câu)
   - Kiểm Tra (trắc nghiệm + bài “điền chữ còn thiếu”)
3. **Tích hợp AI chấm điểm**:
   - So sánh ngữ nghĩa bằng embedding (SentenceTransformer) cho nói/viết câu.
   - Kiểm tra chính tả/ngữ pháp (LanguageTool) cho phần viết (nếu môi trường có Java).
4. **Tối ưu trải nghiệm học**:
   - TTS (gTTS) phát âm mẫu.
   - Phiên âm (IPA) lấy từ dictionary API và cache.
5. **Cơ chế điểm & lịch sử**:
   - Frontend lưu tiến độ/điểm theo topic bằng `localStorage`.
   - Backend lưu lịch sử chi tiết vào `learning_history.json`.
   - Quy tắc quan trọng: **câu đã làm đúng rồi thì làm lại không cộng điểm**, nhưng vẫn cho phép làm lại để luyện tập.

## 4) Nguyên lý hoạt động của “AI” trong dự án

### 4.1. Chấm nói (Speaking)
- Input: câu/ từ người học nói (SpeechRecognition ở trình duyệt) và đáp án chuẩn.
- Backend tạo embedding cho `user_answer` và `correct_answer` bằng mô hình `SentenceTransformer('all-MiniLM-L6-v2')`.
- Tính độ tương đồng cosine và quy đổi ra điểm 0–100.
- Ngưỡng kết luận (hiện tại):
  - $\ge 85$: coi là đúng
  - $60–84$: gần đúng (gợi ý)
  - $< 60$: sai (gợi ý)

Lưu ý: đây là chấm theo **độ giống ngữ nghĩa** (semantic similarity), không phải nhận diện phát âm chuyên sâu.

### 4.2. Chấm viết từ (Writing)
- Nếu người dùng nhập đúng chính tả (case-insensitive) → 100 điểm.
- Nếu sai:
  - Nếu có LanguageTool (cần Java) → trả về thông báo lỗi và gợi ý sửa (nếu có).
  - Nếu không có LanguageTool → báo sai và đưa đáp án đúng.

### 4.3. Chấm viết câu (Grammar)
- Chấm theo embedding similarity giữa câu người dùng và câu mẫu.
- Có thể kèm gợi ý lỗi ngữ pháp từ LanguageTool (nếu khả dụng).

### 4.4. Trắc nghiệm (Quiz)
- So sánh đáp án chọn với đáp án đúng.
- Điểm mặc định cho 1 câu đúng là 100 (điểm “thô” ở backend).

### 4.5. Quy tắc “đúng 1 lần” (không cộng lại)
Dù mode nào (speaking/writing/grammar/quiz), backend đều:
- Tạo `question_id` ổn định từ `mode + gradeId + topicId + category + itemId + label`.
- Kiểm tra trong `learning_history.json` xem câu đó đã từng “Đúng” trước đó chưa.
- Trả về:
  - `already_correct`: đã đúng trước đó hay chưa
  - `awarded_score`: điểm **được tính lần này** (0 nếu đã đúng trước đó)

Frontend có thể dựa vào `already_correct` để quyết định có cộng điểm/đánh dấu hoàn thành hay không.

## 5) Các chức năng AI cung cấp

### 5.1. AI chấm điểm & phản hồi
- Chấm nói theo mức độ tương đồng (embedding cosine similarity).
- Chấm viết câu theo mức độ tương đồng ngữ nghĩa.
- Chấm viết từ theo chính tả + (tuỳ chọn) gợi ý ngữ pháp/chính tả từ LanguageTool.
- Trả về phản hồi gồm:
  - `message` (kết quả)
  - `score` (điểm thô)
  - `suggestion` (gợi ý sửa)
  - `already_correct`, `awarded_score` (quy tắc đúng 1 lần)

### 5.2. TTS phát âm mẫu (Text-to-Speech)
- API `/api/tts?text=...` tạo âm thanh tiếng Anh bằng gTTS và trả về mp3.
- Frontend dùng để “Nghe mẫu” và phản hồi khi làm đúng/sai.

### 5.3. Phiên âm (IPA / phonetic)
- API `/api/phonetic?word=...` gọi `dictionaryapi.dev` để lấy phiên âm.
- Có cache trong backend (`PHONETIC_CACHE`) và cache trong frontend để giảm số lần gọi.
- Hiển thị phiên âm ở:
  - Tab Học Từ Vựng
  - Tab Luyện Nói

### 5.4. Chatbot hỗ trợ dịch (Translation assistant)
### 5.4. Chatbot hỗ trợ học (Q&A Vocabulary / Grammar / Pronunciation)
- API `/api/chat` nhận tin nhắn và trả lời theo kiểu “trợ lý học tập” cho học sinh tiểu học.
- Chatbot có 3 chế độ chính:
  - **Từ vựng**: Robo hỏi “Tiếng Anh của … là gì?” → bé trả lời.
  - **Ngữ pháp**: Robo đưa câu tiếng Việt → bé viết câu tiếng Anh (AI chấm theo độ tương đồng ngữ nghĩa).
  - **Phát âm**: Robo đưa 1 từ tiếng Anh → bé bấm micro để đọc (SpeechRecognition của trình duyệt) và chấm qua API `/api/check`.

Nguyên tắc sử dụng:
- Chatbot ưu tiên hỏi theo **chủ đề đang chọn** (Lớp/Topic). Nếu chưa chọn chủ đề, chatbot sẽ nhắc bé chọn bài trước.
- Chatbot có **trạng thái phiên** theo `client_id` (frontend gửi lên) để biết “câu hỏi đang chờ bé trả lời”.
- Vẫn hỗ trợ **dịch** khi người dùng gõ rõ “dịch … / nghĩa là … / tiếng Anh là …”.

Lưu ý: phần “phát âm” ở đây dựa vào kết quả nhận dạng giọng nói (ASR) + chấm mức độ giống từ/câu mẫu, không phải hệ thống chấm IPA/phoneme chuyên sâu.

## 6) Luồng hoạt động (End-to-end)
1. Người dùng chọn lớp/chủ đề → frontend gọi `/api/curriculum` và `/api/topic/<grade>/<topic>`.
2. Khi người dùng làm bài (nói/viết/quiz/missing letters) → frontend gọi POST `/api/check`.
3. Backend chấm điểm + kiểm tra `already_correct` + ghi `learning_history.json`.
4. Frontend hiển thị phản hồi và (nếu là lần đúng đầu tiên) cộng điểm vào `localStorage` theo từng topic.

Chatbot:
1. Bé mở khung chat và nhắn “từ vựng / ngữ pháp / phát âm” → frontend gọi POST `/api/chat` kèm `client_id` và `context` (gradeId/topicId).
2. Backend tạo câu hỏi dựa trên dữ liệu trong `CURRICULUM` và lưu trạng thái chờ trả lời theo `client_id`.
3. Bé trả lời bằng text (từ vựng/ngữ pháp) hoặc bấm micro (phát âm) → backend chấm và trả phản hồi.

## 7) Chạy dự án (Windows)
### 7.1. Cài đặt
Yêu cầu Python 3.x.

Cài các thư viện (gợi ý):
```bash
pip install flask googletrans==4.0.0-rc1 gTTS sentence-transformers language-tool-python
```

Ghi chú:
- `sentence-transformers` sẽ kéo theo PyTorch phù hợp.
- `language-tool-python` cần Java để chạy đầy đủ. Nếu không có Java, app vẫn chạy nhưng phần gợi ý ngữ pháp có thể bị bỏ qua.

### 7.2. Chạy
```bash
python app.py
```
Mở trình duyệt tại: `http://127.0.0.1:5000/`

## 8) Dữ liệu & ghi lịch sử
- Điểm theo chủ đề: lưu ở `localStorage` (key: `robo_english_scores_v1`).
- Lịch sử làm bài: lưu ở [learning_history.json](learning_history.json) theo bản ghi:
  - `timestamp`, `mode`, `question`, `question_id`, `context`, `user_answer`, `score`, `base_score`, `counted`, `result`.

## 9) Giới hạn & lưu ý kỹ thuật
- Chấm nói/viết câu dựa vào **độ tương đồng embedding**, không đảm bảo đánh giá phát âm/grammar chuẩn như hệ thống chuyên dụng.
- Phiên âm phụ thuộc dịch vụ `dictionaryapi.dev` (cần internet).
- TTS dùng gTTS (cần internet).
- Chatbot có thể dùng googletrans cho chức năng dịch (cần internet, đôi khi có thể bị giới hạn).
- Luyện phát âm trong chatbot phụ thuộc trình duyệt hỗ trợ `SpeechRecognition` (Chrome/Edge thường hỗ trợ; một số trình duyệt có thể không có).

---

Nếu bạn muốn, mình có thể bổ sung thêm phần “Sơ đồ API” (request/response mẫu) cho từng endpoint trong README.
