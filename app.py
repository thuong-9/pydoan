from flask import Flask, render_template, request, jsonify, send_file
from googletrans import Translator
from gtts import gTTS
import re 
import io
import json
import os
import threading
from difflib import SequenceMatcher
from datetime import datetime
import urllib.request
import urllib.parse
import random

app = Flask(__name__)
app.secret_key = 'robo_english_super_secret'

translator = Translator()

# --- TỐI ƯU STARTUP ---
# Tránh load mô hình AI/LanguageTool ngay khi import module (startup sẽ rất chậm).
# Thay vào đó, lazy-load khi endpoint cần.
_ai_lock = threading.Lock()
ai_model = None
_st_util = None

_grammar_lock = threading.Lock()
grammar_tool = None
_grammar_initialized = False


def _get_ai_model_and_util():
    """Trả về (ai_model, util) của sentence-transformers. Lazy-load để app khởi động nhanh."""
    global ai_model, _st_util
    if ai_model is not None and _st_util is not None:
        return ai_model, _st_util

    with _ai_lock:
        if ai_model is None or _st_util is None:
            # Import nặng (torch/sentence-transformers) -> để bên trong.
            from sentence_transformers import SentenceTransformer, util as st_util

            model_name = os.getenv('ROBO_ST_MODEL', 'all-MiniLM-L6-v2')
            print(f"⏳ Đang tải mô hình AI: {model_name}...")
            ai_model = SentenceTransformer(model_name)
            _st_util = st_util
            print("✅ Đã tải xong mô hình AI!")

    return ai_model, _st_util


def _get_grammar_tool():
    """Lazy-load LanguageTool (cần Java). Nếu không khả dụng thì trả về None."""
    global grammar_tool, _grammar_initialized
    if _grammar_initialized:
        return grammar_tool

    with _grammar_lock:
        if not _grammar_initialized:
            try:
                import language_tool_python

                grammar_tool = language_tool_python.LanguageTool('en-US')
                print("✅ Đã tải xong LanguageTool!")
            except Exception as exc:
                # Không chặn app nếu máy chưa có Java hoặc bị lỗi tải.
                grammar_tool = None
                print("⚠️ Không tải được LanguageTool. Bỏ qua kiểm tra ngữ pháp nâng cao.")
                print(f"Chi tiết: {exc}")
            finally:
                _grammar_initialized = True

    return grammar_tool

HISTORY_FILE = 'learning_history.json'

# Cache phiên âm (tránh gọi API liên tục)
PHONETIC_CACHE = {}

def _load_history():
    if not os.path.exists(HISTORY_FILE):
        return []
    try:
        with open(HISTORY_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _write_history(history):
    with open(HISTORY_FILE, 'w', encoding='utf-8') as f:
        json.dump(history, f, ensure_ascii=False, indent=4)


def _normalize_key(value):
    if value is None:
        return ''
    return str(value).strip().lower()


def _has_been_correct_before(question_id=None, mode=None, question=None):
    """Trả về True nếu câu này đã từng được trả lời ĐÚNG trước đó."""
    qid = _normalize_key(question_id)
    m = _normalize_key(mode)
    q = _normalize_key(question)
    history = _load_history()
    for rec in history:
        if not isinstance(rec, dict):
            continue

        rec_result = rec.get('result')
        if rec_result != 'Đúng':
            continue

        rec_qid = _normalize_key(rec.get('question_id'))
        if qid and rec_qid and rec_qid == qid:
            return True

        # Fallback cho dữ liệu cũ chưa có question_id
        if not qid:
            if m and _normalize_key(rec.get('mode')) != m:
                continue
            if q and _normalize_key(rec.get('question')) != q:
                continue
            if m or q:
                return True

    return False


def save_to_history(mode, question, user_ans, score, is_correct, *, question_id=None, base_score=None, counted=None, context=None):
    """Hàm lưu kết quả học tập vào file JSON

    Quy ước mới:
    - score: điểm được TÍNH (0 nếu câu đã đúng trước đó)
    - base_score: điểm thô/AI chấm (để hiển thị, không nhất thiết được tính)
    - counted: True/False nếu lần này có tính điểm
    - question_id: khóa định danh ổn định cho 1 câu hỏi
    - context: thông tin ngữ cảnh (grade/topic/category/item)
    """
    record = {
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "mode": mode,
        "question": question,
        "question_id": question_id,
        "context": context,
        "user_answer": user_ans,
        "score": score,
        "base_score": base_score,
        "counted": counted,
        "result": "Đúng" if is_correct else "Sai",
    }

    history = _load_history()
    history.append(record)
    _write_history(history)


def _fetch_phonetic_from_dictionary_api(word: str):
    """Lấy phiên âm/IPA từ dictionaryapi.dev. Trả về chuỗi hoặc '' nếu không có."""
    if not word:
        return ''

    # API này thường không hỗ trợ cụm từ; thử nguyên cụm trước, nếu fail thì thử từ đầu
    candidates = [word.strip(), word.strip().split(' ')[0]]
    for w in candidates:
        w = w.strip()
        if not w:
            continue
        try:
            url = f"https://api.dictionaryapi.dev/api/v2/entries/en/{urllib.parse.quote(w)}"
            with urllib.request.urlopen(url, timeout=5) as resp:
                raw = resp.read().decode('utf-8', errors='ignore')
            data = json.loads(raw)
            if not isinstance(data, list) or not data:
                continue

            entry = data[0] if isinstance(data[0], dict) else None
            if not entry:
                continue

            # Ưu tiên field 'phonetic'
            phonetic = entry.get('phonetic')
            if isinstance(phonetic, str) and phonetic.strip():
                return phonetic.strip()

            # Nếu không có, thử trong phonetics[]
            phonetics = entry.get('phonetics')
            if isinstance(phonetics, list):
                for p in phonetics:
                    if not isinstance(p, dict):
                        continue
                    text = p.get('text')
                    if isinstance(text, str) and text.strip():
                        return text.strip()
        except Exception:
            continue

    return ''


@app.route('/api/phonetic')
def phonetic_api():
    word = request.args.get('word', '')
    word = str(word).strip()
    if not word:
        return jsonify({"phonetic": ""})

    key = _normalize_key(word)
    if key in PHONETIC_CACHE:
        return jsonify({"phonetic": PHONETIC_CACHE[key]})

    phonetic = _fetch_phonetic_from_dictionary_api(word)
    PHONETIC_CACHE[key] = phonetic
    return jsonify({"phonetic": phonetic})
# --- 1. CƠ SỞ DỮ LIỆU GIÁO TRÌNH (ĐÃ CẬP NHẬT ĐỦ 5 LỚP) ---
CURRICULUM = {
    "lop1": {
        "title": "Lớp 1",
        "topics": {
            "playground": {
                "title": "Sân chơi (School playground)",
                "vocab": [
                    {"en": "Slide", "vi": "Cầu trượt", "img": "🛝"},
                    {"en": "Swing", "vi": "Xích đu", "img": "🎠"},
                    {"en": "Ball", "vi": "Quả bóng", "img": "⚽"},
                    {"en": "Run", "vi": "Chạy", "img": "🏃"},
                    {"en": "Seesaw", "vi": "Bập bênh", "img": "🪀"},
                    {"en": "Play", "vi": "Chơi", "img": "🎮"},
                ],
                "quiz": [
                    {"question": "Cái gì dùng để trượt xuống?", "options": ["Swing", "Slide", "Ball"], "answer": "Slide"},
                    {"question": "Hành động chạy tiếng Anh là?", "options": ["Run", "Sit", "Stand"], "answer": "Run"},
                    {"question": "Cái gì dùng để đu đưa?", "options": ["Swing", "Slide", "Ball"], "answer": "Swing"},
                    {"question": "'Play' nghĩa là gì?", "options": ["Chạy", "Chơi", "Ngủ"], "answer": "Chơi"},
                ],
                "grammar": [
                    {"prompt_vi": "Đây là cầu trượt.", "answer": "This is a slide."},
                    {"prompt_vi": "Đây là quả bóng.", "answer": "This is a ball."},
                    {"prompt_vi": "Em chạy ở sân chơi.", "answer": "I run in the playground."},
                ],
            },
            "dining_room": {
                "title": "Phòng ăn (Dining room)",
                "vocab": [
                    {"en": "Table", "vi": "Cái bàn", "img": "🪑"},
                    {"en": "Spoon", "vi": "Cái thìa", "img": "🥄"},
                    {"en": "Plate", "vi": "Cái đĩa", "img": "🍽️"},
                    {"en": "Eat", "vi": "Ăn", "img": "😋"},
                    {"en": "Fork", "vi": "Cái nĩa", "img": "🍴"},
                    {"en": "Cup", "vi": "Cái cốc", "img": "🥤"},
                ],
                "quiz": [
                    {"question": "Vật dùng để xúc thức ăn?", "options": ["Table", "Spoon", "Plate"], "answer": "Spoon"},
                    {"question": "Cái cốc tiếng Anh là gì?", "options": ["Cup", "Plate", "Fork"], "answer": "Cup"},
                    {"question": "Vật dùng để xiên thức ăn?", "options": ["Fork", "Spoon", "Table"], "answer": "Fork"},
                ],
                "grammar": [
                    {"prompt_vi": "Đây là cái thìa.", "answer": "This is a spoon."},
                    {"prompt_vi": "Đây là cái đĩa.", "answer": "This is a plate."},
                    {"prompt_vi": "Em ăn.", "answer": "I eat."},
                ],
            },
            "market": {
                "title": "Chợ (Street market)",
                "vocab": [
                    {"en": "Apple", "vi": "Quả táo", "img": "🍎"},
                    {"en": "Banana", "vi": "Quả chuối", "img": "🍌"},
                    {"en": "Market", "vi": "Chợ", "img": "🏪"},
                    {"en": "Buy", "vi": "Mua", "img": "🛍️"},
                    {"en": "Orange", "vi": "Quả cam", "img": "🍊"},
                    {"en": "Sell", "vi": "Bán", "img": "💰"},
                ],
                "quiz": [
                    {"question": "Quả gì màu vàng và cong?", "options": ["Apple", "Banana", "Market"], "answer": "Banana"},
                    {"question": "Quả cam tiếng Anh là gì?", "options": ["Orange", "Apple", "Banana"], "answer": "Orange"},
                    {"question": "'Buy' nghĩa là gì?", "options": ["Mua", "Bán", "Chạy"], "answer": "Mua"},
                ],
                "grammar": [
                    {"prompt_vi": "Đây là chợ.", "answer": "This is a market."},
                    {"prompt_vi": "Tớ mua một quả táo.", "answer": "I buy an apple."},
                    {"prompt_vi": "Quả chuối màu vàng.", "answer": "The banana is yellow."},
                ],
            },
            "bedroom": {
                "title": "Phòng ngủ (Bedroom)",
                "vocab": [
                    {"en": "Bed", "vi": "Cái giường", "img": "🛌"},
                    {"en": "Lamp", "vi": "Đèn ngủ", "img": "💡"},
                    {"en": "Pillow", "vi": "Cái gối", "img": "🛌"},
                    {"en": "Sleep", "vi": "Ngủ", "img": "😴"},
                    {"en": "Blanket", "vi": "Cái chăn", "img": "🛏️"},
                    {"en": "Wake up", "vi": "Thức dậy", "img": "⏰"},
                ],
                "quiz": [
                    {"question": "Chúng ta ngủ ở đâu?", "options": ["Table", "Bed", "Lamp"], "answer": "Bed"},
                    {"question": "'Sleep' nghĩa là gì?", "options": ["Ngủ", "Ăn", "Chạy"], "answer": "Ngủ"},
                    {"question": "Cái chăn tiếng Anh là gì?", "options": ["Blanket", "Lamp", "Pillow"], "answer": "Blanket"},
                ],
                "grammar": [
                    {"prompt_vi": "Đây là cái gối.", "answer": "This is a pillow."},
                    {"prompt_vi": "Tớ ngủ trên giường.", "answer": "I sleep on the bed."},
                    {"prompt_vi": "Tớ thức dậy.", "answer": "I wake up."},
                ],
            },
            "fish_shop": {
                "title": "Cửa hàng cá & khoai (Fish & Chip shop)",
                "vocab": [
                    {"en": "Fish", "vi": "Con cá", "img": "🐟"},
                    {"en": "Chips", "vi": "Khoai tây chiên", "img": "🍟"},
                    {"en": "Chicken", "vi": "Thịt gà", "img": "🍗"},
                    {"en": "Shop", "vi": "Cửa hàng", "img": "🏠"},
                    {"en": "Salt", "vi": "Muối", "img": "🧂"},
                    {"en": "Menu", "vi": "Thực đơn", "img": "📋"},
                ],
                "quiz": [
                    {"question": "Món khoai tây chiên tiếng Anh là?", "options": ["Fish", "Chips", "Chicken"], "answer": "Chips"},
                    {"question": "Muối tiếng Anh là gì?", "options": ["Salt", "Shop", "Fish"], "answer": "Salt"},
                    {"question": "'Shop' nghĩa là gì?", "options": ["Cửa hàng", "Con cá", "Khoai tây"], "answer": "Cửa hàng"},
                ],
                "grammar": [
                    {"prompt_vi": "Tớ muốn cá và khoai tây chiên.", "answer": "I want fish and chips."},
                    {"prompt_vi": "Đây là cửa hàng.", "answer": "This is a shop."},
                    {"prompt_vi": "Gà ngon.", "answer": "The chicken is tasty."},
                ],
            }
        }
    },
    "lop2": {
        "title": " Lớp 2 ",
        "topics": {
            "birthday": {
                "title": "Tiệc sinh nhật (Birthday party)",
                "vocab": [
                    {"en": "Cake", "vi": "Bánh kem", "img": "🎂"},
                    {"en": "Balloon", "vi": "Bóng bay", "img": "🎈"},
                    {"en": "Gift", "vi": "Quà tặng", "img": "🎁"},
                    {"en": "Candle", "vi": "Nến", "img": "🕯️"},
                    {"en": "Party", "vi": "Bữa tiệc", "img": "🥳"},
                    {"en": "Sing", "vi": "Hát", "img": "🎶"},
                ],
                "quiz": [
                    {"question": "Thứ gì thắp sáng trên bánh kem?", "options": ["Balloon", "Candle", "Gift"], "answer": "Candle"},
                    {"question": "Tiệc sinh nhật tiếng Anh là?", "options": ["Birthday party", "Backyard", "Farm"], "answer": "Birthday party"},
                    {"question": "'Gift' nghĩa là gì?", "options": ["Quà tặng", "Bóng bay", "Ngọn nến"], "answer": "Quà tặng"},
                ],
                "grammar": [
                    {"prompt_vi": "Hôm nay là sinh nhật của tớ.", "answer": "Today is my birthday."},
                    {"prompt_vi": "Tớ có một cái bánh.", "answer": "I have a cake."},
                    {"prompt_vi": "Chúng ta hát chúc mừng sinh nhật.", "answer": "We sing Happy Birthday."},
                ],
            },
            "backyard": {
                "title": "Sân sau (Backyard)",
                "vocab": [
                    {"en": "Tree", "vi": "Cái cây", "img": "🌳"},
                    {"en": "Grass", "vi": "Cỏ", "img": "🌿"},
                    {"en": "Flower", "vi": "Bông hoa", "img": "🌸"},
                    {"en": "Kite", "vi": "Cái diều", "img": "🪁"},
                    {"en": "Bird", "vi": "Con chim", "img": "🐦"},
                    {"en": "Garden", "vi": "Khu vườn", "img": "🪴"},
                ],
                "quiz": [
                    {"question": "Cái gì mọc xanh trên mặt đất?", "options": ["Tree", "Grass", "Kite"], "answer": "Grass"},
                    {"question": "Cái diều tiếng Anh là gì?", "options": ["Kite", "Tree", "Flower"], "answer": "Kite"},
                    {"question": "'Grass' nghĩa là gì?", "options": ["Cỏ", "Cây", "Con chim"], "answer": "Cỏ"},
                ],
                "grammar": [
                    {"prompt_vi": "Có một cái cây trong sân.", "answer": "There is a tree in the backyard."},
                    {"prompt_vi": "Đây là bông hoa.", "answer": "This is a flower."},
                    {"prompt_vi": "Con chim ở trong vườn.", "answer": "The bird is in the garden."},
                ],
            },
            "countryside": {
                "title": "Vùng quê (Countryside)",
                "vocab": [
                    {"en": "River", "vi": "Dòng sông", "img": "🌊"},
                    {"en": "Mountain", "vi": "Núi", "img": "⛰️"},
                    {"en": "Field", "vi": "Cánh đồng", "img": "🌾"},
                    {"en": "Road", "vi": "Con đường", "img": "🛣️"},
                    {"en": "Village", "vi": "Ngôi làng", "img": "🏘️"},
                    {"en": "Bridge", "vi": "Cây cầu", "img": "🌉"},
                ],
                "quiz": [
                    {"question": "Nơi nào rất cao?", "options": ["River", "Mountain", "Field"], "answer": "Mountain"},
                    {"question": "'River' nghĩa là gì?", "options": ["Dòng sông", "Núi", "Con đường"], "answer": "Dòng sông"},
                    {"question": "Cánh đồng tiếng Anh là gì?", "options": ["Field", "Road", "Village"], "answer": "Field"}, 
                ],
                "grammar": [
                    {"prompt_vi": "Ngôi làng rất yên bình.", "answer": "The village is peaceful."},
                    {"prompt_vi": "Có một con sông.", "answer": "There is a river."},
                    {"prompt_vi": "Cây cầu ở gần con đường.", "answer": "The bridge is near the road."},
                ],
            },
            "farm": {
                "title": "Nông trại (On the farm)",
                "vocab": [
                    {"en": "Cow", "vi": "Con bò", "img": "🐄"},
                    {"en": "Duck", "vi": "Con vịt", "img": "🦆"},
                    {"en": "Sheep", "vi": "Con cừu", "img": "🐑"},
                    {"en": "Horse", "vi": "Con ngựa", "img": "🐎"},
                    {"en": "Pig", "vi": "Con heo", "img": "🐖"},
                    {"en": "Goat", "vi": "Con dê", "img": "🐐"},
                ],
                "quiz": [
                    {"question": "Con vật nào kêu 'Quác quác'?", "options": ["Cow", "Duck", "Sheep"], "answer": "Duck"},
                    {"question": "Con bò tiếng Anh là?", "options": ["Cow", "Pig", "Goat"], "answer": "Cow"},
                    {"question": "Con dê tiếng Anh là?", "options": ["Sheep", "Goat", "Horse"], "answer": "Goat"},
                ],
                "grammar": [
                    {"prompt_vi": "Đây là con bò.", "answer": "This is a cow."},
                    {"prompt_vi": "Con vịt ở trên nông trại.", "answer": "The duck is on the farm."},
                    {"prompt_vi": "Tớ thấy một con heo.", "answer": "I see a pig."},
                ],
            },
            "home": {
                "title": "Ở nhà (At home)",
                "vocab": [
                    {"en": "Kitchen", "vi": "Nhà bếp", "img": "🍳"},
                    {"en": "Living room", "vi": "Phòng khách", "img": "🛋️"},
                    {"en": "Door", "vi": "Cửa ra vào", "img": "🚪"},
                    {"en": "Window", "vi": "Cửa sổ", "img": "🪟"},
                    {"en": "Bathroom", "vi": "Phòng tắm", "img": "🚿"},
                    {"en": "Bedroom", "vi": "Phòng ngủ", "img": "🛏️"},
                ],
                "quiz": [
                    {"question": "Nơi để nấu ăn gọi là gì?", "options": ["Kitchen", "Living room", "Door"], "answer": "Kitchen"},
                    {"question": "Phòng khách tiếng Anh là gì?", "options": ["Living room", "Bathroom", "Bedroom"], "answer": "Living room"},
                    {"question": "Cửa sổ tiếng Anh là gì?", "options": ["Window", "Door", "Kitchen"], "answer": "Window"},
                ],
                "grammar": [
                    {"prompt_vi": "Phòng tắm sạch sẽ.", "answer": "The bathroom is clean."},
                    {"prompt_vi": "Phòng ngủ của tôi rộng rãi.", "answer": "My bedroom is spacious."},
                    {"prompt_vi": "Cửa ra vào mở rộng.", "answer": "The door is wide open."},
                ],
            }
        }
    },
    "lop3": {
        "title": "Lớp 3",
        "topics": {
            "hobbies": {
                "title": "Sở thích (My hobbies)",
                "vocab": [
                    {"en": "Singing", "vi": "Ca hát", "img": "🎤"},
                    {"en": "Dancing", "vi": "Nhảy múa", "img": "💃"},
                    {"en": "Drawing", "vi": "Vẽ tranh", "img": "🎨"},
                    {"en": "Swimming", "vi": "Bơi lội", "img": "🏊"},
                    {"en": "Reading", "vi": "Đọc sách", "img": "📖"},
                    {"en": "Cooking", "vi": "Nấu ăn", "img": "👩‍🍳"},
                ],
                "quiz": [
                    {"question": "Hành động cầm mic hát là?", "options": ["Dancing", "Singing", "Drawing"], "answer": "Singing"},
                    {"question": "Hành động di chuyển theo nhạc là?", "options": ["Dancing", "Cooking", "Reading"], "answer": "Dancing"},
                    {"question": "'Drawing' nghĩa là gì?", "options": ["Vẽ tranh", "Bơi lội", "Ca hát"], "answer": "Vẽ tranh"},
                ],
                "grammar": [
                    {"prompt_vi": "Tớ thích ca hát.", "answer": "I like singing."},
                    {"prompt_vi": "Cô ấy đang nhảy múa.", "answer": "She is dancing."},
                    {"prompt_vi": "Chúng ta cùng vẽ tranh nhé.", "answer": "Let's draw together."},
                ]
            },
            "colours": {
                "title": "Màu sắc (Colours)",
                "vocab": [
                    {"en": "Red", "vi": "Màu đỏ", "img": "🔴"},
                    {"en": "Blue", "vi": "Màu xanh dương", "img": "🔵"},
                    {"en": "Green", "vi": "Màu xanh lá", "img": "🟢"},
                    {"en": "Yellow", "vi": "Màu vàng", "img": "🟡"},
                    {"en": "Black", "vi": "Màu đen", "img": "⚫"},
                    {"en": "White", "vi": "Màu trắng", "img": "⚪"},
                ],
                "quiz": [
                    {"question": "Màu của bầu trời là?", "options": ["Red", "Blue", "Green"], "answer": "Blue"},
                    {"question": "'Yellow' nghĩa là gì?", "options": ["Màu vàng", "Màu đen", "Màu trắng"], "answer": "Màu vàng"},
                    {"question": "Màu của lá cây là?", "options": ["Green", "Red", "Blue"], "answer": "Green"},
                ],
                "grammar": [
                    {"prompt_vi": "Màu đỏ là màu của quả táo.", "answer": "Red is the color of an apple."},
                    {"prompt_vi": "Bầu trời có màu xanh dương.", "answer": "The sky is blue."},
                    {"prompt_vi": "Lá cây có màu xanh lá.", "answer": "Leaves are green."},
                ],
            },
            "break_time": {
                "title": "Giờ ra chơi (Break time)",
                "vocab": [
                    {"en": "Football", "vi": "Bóng đá", "img": "⚽"},
                    {"en": "Chess", "vi": "Cờ vua", "img": "♟️"},
                    {"en": "Basketball", "vi": "Bóng rổ", "img": "🏀"},
                    {"en": "Chatting", "vi": "Trò chuyện", "img": "🗣️"},
                    {"en": "Reading", "vi": "Đọc sách", "img": "📚"},
                    {"en": "Drawing", "vi": "Vẽ tranh", "img": "🎨"},
                ],
                "quiz": [
                    {"question": "Trò chơi trí tuệ với các quân cờ?", "options": ["Football", "Chess", "Basketball"], "answer": "Chess"},
                    {"question": "'Chatting' nghĩa là gì?", "options": ["Trò chuyện", "Đọc sách", "Vẽ tranh"], "answer": "Trò chuyện"},
                    {"question": "Trò chơi với quả bóng tròn lớn?", "options": ["Football", "Chess", "Basketball"], "answer": "Basketball"},
                ],
                "grammar": [
                    {"prompt_vi": "Tớ thích ca hát.", "answer": "I like singing."},
                    {"prompt_vi": "Cô ấy đang nhảy múa.", "answer": "She is dancing."},
                    {"prompt_vi": "Chúng ta cùng vẽ tranh nhé.", "answer": "Let's draw together."},
                ],
            },
            "family": {
                "title": "Gia đình (Family)",
                "vocab": [
                    {"en": "Father", "vi": "Bố", "img": "👨"},
                    {"en": "Mother", "vi": "Mẹ", "img": "👩"},
                    {"en": "Brother", "vi": "Anh/Em trai", "img": "👦"},
                    {"en": "Sister", "vi": "Chị/Em gái", "img": "👧"},
                    {"en": "Grandmother", "vi": "Bà", "img": "👵"},
                    {"en": "Grandfather", "vi": "Ông", "img": "👴"},
                ],
                "quiz": [
                    {"question": "Ai là người sinh ra bố hoặc mẹ?", "options": ["Sister", "Grandmother", "Brother"], "answer": "Grandmother"},
                    {"question": "'Mother' nghĩa là gì?", "options": ["Bố", "Mẹ", "Bà"], "answer": "Mẹ"},
                    {"question": "Điền từ còn thiếu: F_ther", "options": ["a", "o", "e"], "answer": "a"}
                ],
                "grammar": [
                    {"prompt_vi": "Bố là người chăm sóc gia đình.", "answer": "Father is the one who takes care of the family."},
                    {"prompt_vi": "Mẹ nấu ăn rất ngon.", "answer": "Mother cooks very well."},
                    {"prompt_vi": "Anh trai đang chơi bóng đá.", "answer": "Brother is playing football."},
                ],
            },
            "school": {
                "title": "Trường học (School)",
                "vocab": [
                    {"en": "Teacher", "vi": "Giáo viên", "img": "👩‍🏫"},
                    {"en": "Student", "vi": "Học sinh", "img": "🎒"},
                    {"en": "Pencil", "vi": "Bút chì", "img": "✏️"},
                    {"en": "Book", "vi": "Quyển sách", "img": "📚"},
                    {"en": "Desk", "vi": "Cái bàn học", "img": "🪑"},
                    {"en": "Classroom", "vi": "Phòng học", "img": "🏫"},
                ],
                "quiz": [
                    {"question": "Vật dùng để viết là gì?", "options": ["Book", "Pencil", "Teacher"], "answer": "Pencil"},
                    {"question": "Người dạy học gọi là?", "options": ["Student", "Teacher", "Mother"], "answer": "Teacher"},
                    {"question": "'Desk' nghĩa là gì?", "options": ["Cái bàn học", "Quyển sách", "Phòng học"], "answer": "Cái bàn học"},
                ],
                "grammar": [
                    {"prompt_vi": "Cô giáo rất tốt bụng.", "answer": "The teacher is very kind."},
                    {"prompt_vi": "Học sinh đang học bài.", "answer": "The student is studying."},
                    {"prompt_vi": "Tớ thích viết bằng bút chì.", "answer": "I like writing with a pencil."},
                ],
            }
        }
    },
    "lop4": {
        "title": "Lớp 4",
        "topics": {
            "food": {
                "title": "Thức ăn (Food)",
                "vocab": [
                    {"en": "Rice", "vi": "Cơm", "img": "🍚"},
                    {"en": "Noodles", "vi": "Mì", "img": "🍜"},
                    {"en": "Vegetables", "vi": "Rau củ", "img": "🥦"},
                    {"en": "Fruits", "vi": "Trái cây", "img": "🍎"},
                    {"en": "Meat", "vi": "Thịt", "img": "🍖"},
                    {"en": "Fish", "vi": "Cá", "img": "🐟"},
                ],
                "quiz": [
                    {"question": "Thức ăn làm từ hạt lúa?", "options": ["Rice", "Noodles", "Fruits"], "answer": "Rice"},
                    {"question": "'Vegetables' nghĩa là gì?", "options": ["Rau củ", "Trái cây", "Thịt"], "answer": "Rau củ"},
                    {"question": "Thức ăn làm từ bột mì?", "options": ["Rice", "Noodles", "Fish"], "answer": "Noodles"},
                ],
                "grammar": [
                    {"prompt_vi": "Tớ thích ăn cơm.", "answer": "I like eating rice."},
                    {"prompt_vi": "Mì rất ngon.", "answer": "Noodles are delicious."},
                    {"prompt_vi": "Rau củ tốt cho sức khỏe.", "answer": "Vegetables are good for health."},
                ],
            },
            "bodies": {
                "title": "Cơ thể (Our bodies)",
                "vocab": [
                    {"en": "Head", "vi": "Đầu", "img": "🙆"},
                    {"en": "Arm", "vi": "Cánh tay", "img": "💪"},
                    {"en": "Leg", "vi": "Chân", "img": "🦵"},
                    {"en": "Hand", "vi": "Bàn tay", "img": "✋"},
                    {"en": "Eye", "vi": "Mắt", "img": "👁️"},
                    {"en": "Mouth", "vi": "Miệng", "img": "👄"},
                ],
                "quiz": [
                    {"question": "Bộ phận dùng để cầm nắm?", "options": ["Head", "Leg", "Hand"], "answer": "Hand"},
                    {"question": "'Eye' nghĩa là gì?", "options": ["Mắt", "Miệng", "Đầu"], "answer": "Mắt"},
                    {"question": "Bộ phận dùng để đi lại?", "options": ["Arm", "Leg", "Hand"], "answer": "Leg"},
                ],
                "grammar": [
                    {"prompt_vi": "Đây là cái đầu.", "answer": "This is a head."},
                    {"prompt_vi": "Cánh tay của tôi dài.", "answer": "My arm is long."},
                    {"prompt_vi": "Tôi dùng chân để đi bộ.", "answer": "I use my legs to walk."},
                ],
            },
            "animals": {
                "title": "Động vật (Animals)",
                "vocab": [
                    {"en": "Tiger", "vi": "Con hổ", "img": "🐯"},
                    {"en": "Monkey", "vi": "Con khỉ", "img": "🐵"},
                    {"en": "Elephant", "vi": "Con voi", "img": "🐘"},
                    {"en": "Lion", "vi": "Sư tử", "img": "🦁"},
                    {"en": "Giraffe", "vi": "Hươu cao cổ", "img": "🦒"},
                    {"en": "Zebra", "vi": "Ngựa vằn", "img": "🦓"},
                ],
                "quiz": [
                    {"question": "Con vật nào có vòi dài?", "options": ["Tiger", "Elephant", "Monkey"], "answer": "Elephant"},
                    {"question": "'Lion' nghĩa là gì?", "options": ["Sư tử", "Hươu cao cổ", "Ngựa vằn"], "answer": "Sư tử"},
                    {"question": "Con vật nào có sọc đen trắng?", "options": ["Zebra", "Tiger", "Giraffe"], "answer": "Zebra"},
                ],
                "grammar": [
                    {"prompt_vi": "Con hổ sống trong rừng.", "answer": "The tiger lives in the forest."},
                    {"prompt_vi": "Con khỉ thích ăn chuối.", "answer": "The monkey likes to eat bananas."},
                    {"prompt_vi": "Con voi rất lớn.", "answer": "The elephant is very big."},
                ],
            },
            "weather": {
                "title": "Thời tiết (Weather)",
                "vocab": [
                    {"en": "Sunny", "vi": "Nắng", "img": "☀️"},
                    {"en": "Rainy", "vi": "Mưa", "img": "🌧️"},
                    {"en": "Windy", "vi": "Có gió", "img": "🌬️"},
                    {"en": "Cloudy", "vi": "Nhiều mây", "img": "☁️"},
                    {"en": "Stormy", "vi": "Bão", "img": "🌩️"},
                    {"en": "Snowy", "vi": "Có tuyết", "img": "❄️"},
                ],
                "quiz": [
                    {"question": "Khi trời có nước rơi xuống?", "options": ["Sunny", "Rainy", "Windy"], "answer": "Rainy"},
                    {"question": "'Cloudy' nghĩa là gì?", "options": ["Nhiều mây", "Nắng", "Bão"], "answer": "Nhiều mây"},
                    {"question": "Khi trời có tuyết rơi?", "options": ["Snowy", "Stormy", "Sunny"], "answer": "Snowy"},
                ],
            },
            "sports_day": {
                "title": "Ngày hội thể thao (Sports day)",
                "vocab": [
                    {"en": "Running", "vi": "Chạy đua", "img": "🏃"},
                    {"en": "Badminton", "vi": "Cầu lông", "img": "🏸"},
                    {"en": "Win", "vi": "Chiến thắng", "img": "🏆"},
                    {"en": "Team", "vi": "Đội", "img": "🤝"},
                    {"en": "Jump", "vi": "Nhảy", "img": "🤸"},
                    {"en": "Throw", "vi": "Ném", "img": "🏋️"},
                ],
                "quiz": [
                    {"question": "Môn thể thao dùng vợt và quả cầu?", "options": ["Running", "Badminton", "Team"], "answer": "Badminton"},
                    {"question": "'Win' nghĩa là gì?", "options": ["Chiến thắng", "Nhảy", "Ném"], "answer": "Chiến thắng"},
                    {"question": "Hành động di chuyển nhanh bằng chân?", "options": ["Jump", "Throw", "Running"], "answer": "Running"},
                ],
                "grammar": [
                    {"prompt_vi": "Tớ thích chạy đua.", "answer": "I like running."},
                    {"prompt_vi": "Chúng ta là một đội.", "answer": "We are a team."},
                    {"prompt_vi": "Cô ấy nhảy rất cao.", "answer": "She jumps very high."},
                ],
            }
        }
    },
    "lop5": {
        "title": "Lớp 5",
        "topics": {
            "about_me": {
                "title": "Về bản thân (All about me)",
                "vocab": [
                    {"en": "Name", "vi": "Tên", "img": "🏷️"},
                    {"en": "Age", "vi": "Tuổi", "img": "🎂"},
                    {"en": "Address", "vi": "Địa chỉ", "img": "🏠"},
                    {"en": "Class", "vi": "Lớp học", "img": "🏫"},
                    {"en": "Hobby", "vi": "Sở thích", "img": "🎨"},
                    {"en": "Favorite", "vi": "Yêu thích", "img": "❤️"},
                ],
                "quiz": [
                    {"question": "Từ dùng để hỏi bạn bao nhiêu tuổi?", "options": ["Name", "Age", "Address"], "answer": "Age"},
                    {"question": "'Hobby' nghĩa là gì?", "options": ["Sở thích", "Địa chỉ", "Lớp học"], "answer": "Sở thích"},
                    {"question": "Từ dùng để hỏi tên bạn là gì?", "options": ["Name", "Favorite", "Class"], "answer": "Name"},
                ],
                "grammar": [
                    {"prompt_vi": "Tớ tên là An.", "answer": "My name is An."},
                    {"prompt_vi": "Tớ 10 tuổi.", "answer": "I am 10 years old."},
                    {"prompt_vi": "Sở thích của tớ là vẽ tranh.", "answer": "My hobby is drawing."},
                ],
            },
            "future_job": {
                "title": "Nghề nghiệp tương lai",
                "vocab": [
                    {"en": "Doctor", "vi": "Bác sĩ", "img": "👨‍⚕️"},
                    {"en": "Pilot", "vi": "Phi công", "img": "👨‍✈️"},
                    {"en": "Teacher", "vi": "Giáo viên", "img": "👩‍🏫"},
                    {"en": "Farmer", "vi": "Nông dân", "img": "🧑‍🌾"},
                    {"en": "Engineer", "vi": "Kỹ sư", "img": "👷"},
                    {"en": "Artist", "vi": "Nghệ sĩ", "img": "🎨"},
                ],
                "quiz": [
                    {"question": "Ai là người chữa bệnh?", "options": ["Pilot", "Doctor", "Teacher"], "answer": "Doctor"},
                    {"question": "'Engineer' nghĩa là gì?", "options": ["Kỹ sư", "Nông dân", "Nghệ sĩ"], "answer": "Kỹ sư"},
                    {"question": "Ai là người lái máy bay?", "options": ["Farmer", "Pilot", "Artist"], "answer": "Pilot"},
                ],
                "grammar": [
                    {"prompt_vi": "Tớ muốn trở thành bác sĩ.", "answer": "I want to be a doctor."},
                    {"prompt_vi": "Cô ấy là một giáo viên.", "answer": "She is a teacher."},
                    {"prompt_vi": "Anh ấy làm kỹ sư.", "answer": "He works as an engineer."},
                ],
            },
            "school_trip": {
                "title": "Chuyến đi chơi (School trip)",
                "vocab": [
                    {"en": "Zoo", "vi": "Sở thú", "img": "🦁"},
                    {"en": "Museum", "vi": "Bảo tàng", "img": "🏛️"},
                    {"en": "Beach", "vi": "Bãi biển", "img": "🏖️"},
                    {"en": "Bus", "vi": "Xe buýt", "img": "🚌"},
                    {"en": "Guide", "vi": "Hướng dẫn viên", "img": "🧑‍✈️"},
                    {"en": "Ticket", "vi": "Vé", "img": "🎟️"},
                ],
                "quiz": [
                    {"question": "Nơi trưng bày các vật cổ xưa?", "options": ["Zoo", "Museum", "Beach"], "answer": "Museum"},
                    {"question": "'Guide' nghĩa là gì?", "options": ["Hướng dẫn viên", "Vé", "Xe buýt"], "answer": "Hướng dẫn viên"},
                    {"question": "Phương tiện di chuyển đến trường?", "options": ["Bus", "Zoo", "Ticket"], "answer": "Bus"},
                ],
                "grammar": [
                    {"prompt_vi": "Chúng tớ đi đến sở thú bằng xe buýt.", "answer": "We go to the zoo by bus."},
                    {"prompt_vi": "Hướng dẫn viên rất thân thiện.", "answer": "The guide is very friendly."},
                    {"prompt_vi": "Tớ có một vé vào bảo tàng.", "answer": "I have a ticket to the museum."},
                ],
            },
            "school_activities": {
                "title": "Hoạt động trường học",
                "vocab": [
                    {"en": "Music club", "vi": "CLB Âm nhạc", "img": "🎵"},
                    {"en": "Art club", "vi": "CLB Mỹ thuật", "img": "🎨"},
                    {"en": "Science", "vi": "Khoa học", "img": "🧪"},
                    {"en": "English", "vi": "Tiếng Anh", "img": "📘"},
                    {"en": "Sports", "vi": "Thể thao", "img": "🏅"},
                    {"en": "Drama club", "vi": "CLB Kịch nghệ", "img": "🎭"},
                ],
                "quiz": [
                    {"question": "Môn học vẽ tranh?", "options": ["Music club", "Art club", "Science"], "answer": "Art club"},
                    {"question": "'Drama club' nghĩa là gì?", "options": ["CLB Kịch nghệ", "CLB Âm nhạc", "Thể thao"], "answer": "CLB Kịch nghệ"},
                    {"question": "Môn học về thí nghiệm và khám phá?", "options": ["Science", "English", "Sports"], "answer": "Science"},
                ],
                "grammar": [
                    {"prompt_vi": "Tớ tham gia CLB Âm nhạc.", "answer": "I join the Music club."},
                    {"prompt_vi": "Cô ấy thích môn Khoa học.", "answer": "She likes Science."},
                    {"prompt_vi": "Chúng ta chơi thể thao vào cuối tuần.", "answer": "We play sports on weekends."},
                ]
            },
            "foreign_friends": {
                "title": "Bạn bè quốc tế",
                "vocab": [
                    {"en": "Friend", "vi": "Bạn bè", "img": "👫"},
                    {"en": "Pen pal", "vi": "Bạn qua thư", "img": "✉️"},
                    {"en": "Country", "vi": "Đất nước", "img": "🌍"},
                    {"en": "Hello", "vi": "Xin chào", "img": "👋"},
                    {"en": "Goodbye", "vi": "Tạm biệt", "img": "👋"},
                    {"en": "Thank you", "vi": "Cảm ơn", "img": "🙏"},
                ],
                "quiz": [
                    {"question": "Người bạn trao đổi thư từ gọi là?", "options": ["Friend", "Pen pal", "Country"], "answer": "Pen pal"},
                    {"question": "'Goodbye' nghĩa là gì?", "options": ["Xin chào", "Cảm ơn", "Tạm biệt"], "answer": "Tạm biệt"},
                    {"question": "Từ dùng để bày tỏ lòng biết ơn?", "options": ["Hello", "Thank you", "Friend"], "answer": "Thank you"},
                ],
                "grammar": [
                    {"prompt_vi": "Bạn của tôi rất thân thiện.", "answer": "My friend is very friendly."},
                    {"prompt_vi": "Tôi có một người bạn qua thư.", "answer": "I have a pen pal."},
                    {"prompt_vi": "Chúng tôi đến từ các đất nước khác nhau.", "answer": "We come from different countries."},
                ],
            }
        }
    }
}

# --- 2. LOGIC HỌC TẬP (Giữ nguyên) ---
# def check_similarity(a, b):
#     return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()
def calculate_ai_score(user_text, correct_text):
    """
    Sử dụng Transformers để so sánh độ tương đồng ngữ nghĩa.
    Trả về điểm số từ 0 đến 100.
    """
    if not user_text: return 0

    model, st_util = _get_ai_model_and_util()
    
    # Mã hóa văn bản thành vector
    embeddings1 = model.encode(user_text, convert_to_tensor=True)
    embeddings2 = model.encode(correct_text, convert_to_tensor=True)
    
    # Tính độ tương đồng cosine
    cosine_score = st_util.cos_sim(embeddings1, embeddings2)
    
    # Chuyển thành thang điểm 100
    score = float(cosine_score[0][0]) * 100
    return int(score) if score > 0 else 0

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/curriculum')
def get_curriculum():
    return jsonify(CURRICULUM)

@app.route('/api/topic/<grade_id>/<topic_id>')
def get_topic_data(grade_id, topic_id):
    try:
        data = CURRICULUM[grade_id]['topics'][topic_id]
        return jsonify(data)
    except KeyError:
        return jsonify({"error": "Không tìm thấy dữ liệu"}), 404

# --- API MỚI: TEXT-TO-SPEECH (gTTS) ---
@app.route('/api/tts')
def tts_api():
    text = request.args.get('text', '')
    if not text: return "No text", 400
    
    # Tạo file audio trong RAM để không rác ổ cứng
    try:
        # Lang='en' cho tiếng Anh chuẩn
        tts = gTTS(text=text, lang='en')
        fp = io.BytesIO()
        tts.write_to_fp(fp)
        fp.seek(0)
        return send_file(fp, mimetype="audio/mpeg")
    except Exception as e:
        print(e)
        return "Error", 500

# --- API CHẤM ĐIỂM CHI TIẾT ---
@app.route('/api/check', methods=['POST'])
def check_answer():
    data = request.json
    mode = data.get('mode')
    user_ans = data.get('user_answer', '').strip()
    correct_ans = data.get('correct_answer', '').strip()

    context = data.get('context') if isinstance(data, dict) else None
    if not isinstance(context, dict):
        context = {}

    # question_text giúp định danh quiz theo đúng "câu hỏi" (không chỉ theo đáp án)
    question_text = data.get('question_text', '') if isinstance(data, dict) else ''
    question_text = str(question_text).strip()

    def make_question_id(default_label: str):
        grade_id = _normalize_key(context.get('gradeId'))
        topic_id = _normalize_key(context.get('topicId'))
        category = _normalize_key(context.get('category'))
        item_id = _normalize_key(context.get('itemId'))
        label = _normalize_key(default_label)

        parts = [
            _normalize_key(mode),
            grade_id,
            topic_id,
            category,
            item_id,
            label,
        ]
        return "::".join([p for p in parts if p])

    result = {
        "is_correct": False, 
        "score": 0, 
        "message": "", 
        "suggestion": "", # Gợi ý sửa lỗi
        "awarded_score": 0,
        "already_correct": False,
    }
    if mode == 'speaking':
        if not user_ans:
            score = 0
        else:
            model, st_util = _get_ai_model_and_util()
            embeddings1 = model.encode(user_ans, convert_to_tensor=True)
            embeddings2 = model.encode(correct_ans, convert_to_tensor=True)
            cosine_score = st_util.cos_sim(embeddings1, embeddings2)
            score = int(float(cosine_score[0][0]) * 100)
        
        result['score'] = score
        if score >= 85:
            result.update({"is_correct": True, "message": f"Tuyệt vời! AI chấm: {score}/100 🌟"})
        elif score >= 60:
            result.update({"is_correct": False, "message": f"Khá tốt ({score}/100). Gần đúng rồi! 💪"})
            result["suggestion"] = f"Bé nói: '{user_ans}' <br> Chuẩn là: '{correct_ans}'"
        else:
            result.update({"is_correct": False, "message": f"Chưa chính xác ({score}/100) 😅"})
            result["suggestion"] = f"Bé nói: '{user_ans}' <br> Chuẩn là: '{correct_ans}'"

        question_label = f"Đọc từ: {correct_ans}"
        question_id = make_question_id(correct_ans)
        already_correct = _has_been_correct_before(question_id=question_id)
        result['already_correct'] = already_correct

        awarded_score = 0
        if result['is_correct'] and not already_correct:
            awarded_score = score
        result['awarded_score'] = awarded_score

        if result['is_correct'] and already_correct:
            result['message'] = f"Đúng rồi! (AI chấm: {score}/100) ✅<br><small>Nhưng câu này bé đã làm đúng trước đó nên không cộng điểm nữa.</small>"

        save_to_history(
            "Speaking",
            question_label,
            user_ans,
            awarded_score,
            result['is_correct'],
            question_id=question_id,
            base_score=score,
            counted=(result['is_correct'] and not already_correct),
            context=context,
        )

    # 2. CHẾ ĐỘ VIẾT (WRITING) - Dùng LanguageTool (Ngữ pháp nâng cao)
    elif mode == 'writing':
        # Kiểm tra chính xác 100% trước
        if user_ans.lower() == correct_ans.lower():
            base_score = 100
            result.update({"is_correct": True, "score": base_score, "message": "Chính xác tuyệt đối! 💯"})

            question_label = f"Viết từ: {correct_ans}"
            question_id = make_question_id(correct_ans)
            already_correct = _has_been_correct_before(question_id=question_id)
            result['already_correct'] = already_correct

            awarded_score = 0 if already_correct else base_score
            result['awarded_score'] = awarded_score
            if already_correct:
                result['message'] = "Đúng rồi! ✅ Nhưng câu này bé đã đúng trước đó nên không cộng điểm nữa."

            save_to_history(
                "Writing",
                question_label,
                user_ans,
                awarded_score,
                True,
                question_id=question_id,
                base_score=base_score,
                counted=(not already_correct),
                context=context,
            )
        else:
            # Nếu sai, dùng LanguageTool kiểm tra lỗi ngữ pháp/chính tả
            matches = []
            tool = _get_grammar_tool()
            if tool is not None:
                matches = tool.check(user_ans)
            
            if len(matches) > 0:
                # Có lỗi ngữ pháp cụ thể
                error_msg = matches[0].message
                suggestion = matches[0].replacements[0] if matches[0].replacements else ""
                
                result["message"] = f"Sai rồi. Đáp án đúng: {correct_ans}"
                result["suggestion"] = f"Lỗi ngữ pháp: {error_msg}. <br>Gợi ý sửa: <b>{suggestion}</b>"
                result["score"] = 0
            else:
                # Không phải lỗi ngữ pháp, chỉ là sai từ vựng
                result["message"] = f"Sai rồi. Đáp án đúng là: {correct_ans}"
                result["score"] = 0

            question_label = f"Viết từ: {correct_ans}"
            question_id = make_question_id(correct_ans)
            result['awarded_score'] = 0
            result['already_correct'] = _has_been_correct_before(question_id=question_id)

            save_to_history(
                "Writing",
                question_label,
                user_ans,
                0,
                False,
                question_id=question_id,
                base_score=0,
                counted=False,
                context=context,
            )

    # 2b. CHẾ ĐỘ VIẾT CÂU (GRAMMAR) - Dùng AI + (tuỳ chọn) LanguageTool
    elif mode == 'grammar':
        # Chấm theo mức độ giống nghĩa với câu mẫu (không bắt buộc giống từng ký tự)
        if not user_ans:
            score = 0
        else:
            model, st_util = _get_ai_model_and_util()
            embeddings1 = model.encode(user_ans, convert_to_tensor=True)
            embeddings2 = model.encode(correct_ans, convert_to_tensor=True)
            cosine_score = st_util.cos_sim(embeddings1, embeddings2)
            score = int(float(cosine_score[0][0]) * 100)

        result['score'] = score

        # Gợi ý lỗi ngữ pháp nếu có Java/LanguageTool
        tool = _get_grammar_tool()
        if tool is not None and user_ans:
            try:
                matches = tool.check(user_ans)
                if len(matches) > 0:
                    error_msg = matches[0].message
                    suggestion = matches[0].replacements[0] if matches[0].replacements else ""
                    if suggestion:
                        result["suggestion"] = f"Lỗi ngữ pháp: {error_msg}. <br>Gợi ý sửa: <b>{suggestion}</b>"
                    else:
                        result["suggestion"] = f"Lỗi ngữ pháp: {error_msg}."
            except Exception:
                pass

        if score >= 85:
            result.update({"is_correct": True, "message": f"Câu của bé rất tốt! ({score}/100) 🌟"})
        elif score >= 60:
            result.update({"is_correct": False, "message": f"Gần đúng rồi ({score}/100). Thử sửa lại nhé! 💪"})
            if not result.get('suggestion'):
                result["suggestion"] = f"Bé viết: '{user_ans}' <br>Gợi ý: '{correct_ans}'"
        else:
            result.update({"is_correct": False, "message": f"Chưa đúng lắm ({score}/100) 😅"})
            if not result.get('suggestion'):
                result["suggestion"] = f"Gợi ý câu mẫu: '{correct_ans}'"

        question_label = f"Viết câu: {correct_ans}" if correct_ans else "Viết câu"
        question_id = make_question_id(correct_ans or question_text or "grammar")
        already_correct = _has_been_correct_before(question_id=question_id)
        result['already_correct'] = already_correct

        awarded_score = 0
        if result['is_correct'] and not already_correct:
            awarded_score = score
        result['awarded_score'] = awarded_score

        if result['is_correct'] and already_correct:
            result['message'] = f"Đúng rồi! ({score}/100) ✅ Nhưng câu này bé đã làm đúng trước đó nên không cộng điểm nữa."

        save_to_history(
            "Grammar",
            question_label,
            user_ans,
            awarded_score,
            result['is_correct'],
            question_id=question_id,
            base_score=score,
            counted=(result['is_correct'] and not already_correct),
            context=context,
        )

    # 3. CHẾ ĐỘ TRẮC NGHIỆM (QUIZ)
    elif mode == 'quiz':
        question_label = f"Câu hỏi: {question_text}" if question_text else "Câu hỏi trắc nghiệm"
        question_id_seed = question_text or correct_ans or "quiz"
        question_id = make_question_id(question_id_seed)

        if user_ans == correct_ans:
            base_score = 100
            already_correct = _has_been_correct_before(question_id=question_id)
            result['already_correct'] = already_correct

            awarded_score = 0 if already_correct else base_score
            result.update({"is_correct": True, "score": base_score, "awarded_score": awarded_score})
            if already_correct:
                result['message'] = "Đúng rồi! ✅ Nhưng câu này bé đã đúng trước đó nên không cộng điểm nữa."
            else:
                result['message'] = "Đúng rồi! 🎉"

            save_to_history(
                "Quiz",
                question_label,
                user_ans,
                awarded_score,
                True,
                question_id=question_id,
                base_score=base_score,
                counted=(not already_correct),
                context=context,
            )
        else:
            result["message"] = "Tiếc quá, sai mất rồi!"
            result['awarded_score'] = 0
            result['already_correct'] = _has_been_correct_before(question_id=question_id)
            save_to_history(
                "Quiz",
                question_label,
                user_ans,
                0,
                False,
                question_id=question_id,
                base_score=0,
                counted=False,
                context=context,
            )

    return jsonify(result)

# --- 3. CHATBOT THÔNG MINH (LOGIC ĐÃ SỬA) ---

BOT_MEMORY = {
    "tên bạn là gì": "Tớ là Robo English!",
    "hello": "Hello! Chào bé.",
    "hi": "Hi there!",
    "xin chào": "Chào bé ngoan!"
}

# Lưu trạng thái hội thoại đơn giản theo client_id (frontend tạo và gửi lên)
CHAT_SESSIONS = {}

# Từ điển cứng để sửa lỗi ngữ pháp các câu ngắn
FIXED_TRANSLATIONS = {
    "tôi đói": "I am hungry",
    "bạn tên gì": "What is your name",
    "bạn là ai": "Who are you"
}

def is_vietnamese(text):
    return bool(re.search(r'[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]', text.lower()))

def clean_input(text):
    keywords = ["dịch câu", "dịch từ", "dịch sang tiếng anh", "dịch sang tiếng việt", 
                "dịch", "nghĩa là gì", "nghĩa là", "là gì", "tiếng anh là", 
                "tiếng việt là", "tiếng anh", "tiếng việt"]
    text_lower = text.lower()
    for kw in keywords:
        text_lower = text_lower.replace(kw, "")
    cleaned = re.sub(r'^[\W_]+|[\W_]+$', '', text_lower)
    return cleaned.strip()

def perform_translation(text, dest_lang):
    if dest_lang == 'en' and text.lower() in FIXED_TRANSLATIONS:
        return FIXED_TRANSLATIONS[text.lower()]
    try:
        translated = translator.translate(text, src='auto', dest=dest_lang)
        return translated.text
    except Exception as e:
        return "Lỗi kết nối server dịch."


def _get_topic_safe(grade_id: str, topic_id: str):
    try:
        grade = CURRICULUM.get(grade_id)
        if not isinstance(grade, dict):
            return None
        topics = grade.get('topics')
        if not isinstance(topics, dict):
            return None
        topic = topics.get(topic_id)
        if not isinstance(topic, dict):
            return None
        return topic
    except Exception:
        return None


def _normalize_en_answer(text: str) -> str:
    text = '' if text is None else str(text)
    text = text.strip().lower()
    # Giữ chữ cái, số và khoảng trắng; loại ký tự lạ
    text = re.sub(r"[^a-z0-9\s']", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _similarity(a: str, b: str) -> float:
    a = _normalize_en_answer(a)
    b = _normalize_en_answer(b)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _get_or_create_chat_session(client_id: str) -> dict:
    key = _normalize_key(client_id)
    if not key:
        key = 'anonymous'
    sess = CHAT_SESSIONS.get(key)
    if not isinstance(sess, dict):
        sess = {
            'pending': None,  # {'type': 'vocab'|'grammar'|'pronounce', ...}
            'gradeId': None,
            'topicId': None,
            'updated_at': datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        CHAT_SESSIONS[key] = sess
    sess['updated_at'] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return sess


def _default_chat_actions():
    return [
        {'action': 'start_vocab', 'label': 'Luyện từ vựng'},
        {'action': 'start_grammar', 'label': 'Luyện ngữ pháp'},
        {'action': 'start_pronounce', 'label': 'Luyện phát âm'},
    ]


def _pick_vocab_question(topic: dict):
    vocab = topic.get('vocab') if isinstance(topic, dict) else None
    if not isinstance(vocab, list) or not vocab:
        return None
    idx = random.randint(0, len(vocab) - 1)
    item = vocab[idx] if isinstance(vocab[idx], dict) else None
    if not item or not item.get('en') or not item.get('vi'):
        return None
    return {
        'type': 'vocab',
        'vocabIndex': idx,
        'en': str(item.get('en')).strip(),
        'vi': str(item.get('vi')).strip(),
    }


def _pick_grammar_question(topic: dict):
    grammar = topic.get('grammar') if isinstance(topic, dict) else None
    if not isinstance(grammar, list) or not grammar:
        return None
    idx = random.randint(0, len(grammar) - 1)
    item = grammar[idx] if isinstance(grammar[idx], dict) else None
    if not item or not item.get('prompt_vi') or not item.get('answer'):
        return None
    return {
        'type': 'grammar',
        'grammarIndex': idx,
        'prompt_vi': str(item.get('prompt_vi')).strip(),
        'answer': str(item.get('answer')).strip(),
    }


def _score_grammar_like_check_api(user_ans: str, correct_ans: str):
    user_ans = (user_ans or '').strip()
    correct_ans = (correct_ans or '').strip()
    if not user_ans or not correct_ans:
        return {
            'score': 0,
            'is_correct': False,
            'message': 'Bé thử viết câu tiếng Anh nhé!',
            'suggestion': f"Gợi ý mẫu: <b>{correct_ans}</b>" if correct_ans else ''
        }

    model, st_util = _get_ai_model_and_util()
    embeddings1 = model.encode(user_ans, convert_to_tensor=True)
    embeddings2 = model.encode(correct_ans, convert_to_tensor=True)
    cosine_score = st_util.cos_sim(embeddings1, embeddings2)
    score = int(float(cosine_score[0][0]) * 100)

    suggestion = ''
    tool = _get_grammar_tool()
    if tool is not None:
        try:
            matches = tool.check(user_ans)
            if matches:
                m = matches[0]
                repl = (m.replacements[0] if m.replacements else '')
                suggestion = f"Lỗi gợi ý: {m.message}." + (f" <br>Gợi ý sửa: <b>{repl}</b>" if repl else '')
        except Exception:
            pass

    if score >= 85:
        return {'score': score, 'is_correct': True, 'message': f"Rất tốt! ({score}/100) ✅", 'suggestion': suggestion}
    if score >= 60:
        return {
            'score': score,
            'is_correct': False,
            'message': f"Gần đúng rồi! ({score}/100)",
            'suggestion': (suggestion + ("<br>" if suggestion else "") + f"Mẫu đúng: <b>{correct_ans}</b>")
        }
    return {
        'score': score,
        'is_correct': False,
        'message': f"Chưa đúng lắm ({score}/100). Bé thử lại nhé!",
        'suggestion': (suggestion + ("<br>" if suggestion else "") + f"Mẫu đúng: <b>{correct_ans}</b>")
    }

@app.route('/api/chat', methods=['POST'])
def chat_bot():
    data = request.json if isinstance(request.json, dict) else {}
    raw_msg = str(data.get('message', '')).strip()
    client_id = str(data.get('client_id', '')).strip()
    context = data.get('context') if isinstance(data, dict) else None
    if not isinstance(context, dict):
        context = {}

    sess = _get_or_create_chat_session(client_id)

    # Cập nhật grade/topic nếu frontend đang chọn bài
    ctx_grade = _normalize_key(context.get('gradeId'))
    ctx_topic = _normalize_key(context.get('topicId'))
    if ctx_grade:
        sess['gradeId'] = ctx_grade
    if ctx_topic:
        sess['topicId'] = ctx_topic

    msg_lower = raw_msg.lower().strip()
    if msg_lower in BOT_MEMORY:
        return jsonify({"reply": BOT_MEMORY[msg_lower], "actions": _default_chat_actions()})

    # Nếu không có message thì trả về hướng dẫn
    if not msg_lower:
        return jsonify({
            "reply": "Chào bé! Robo có thể luyện <b>từ vựng</b>, <b>ngữ pháp</b>, và <b>phát âm</b>. Bé gõ: 'từ vựng' / 'ngữ pháp' / 'phát âm' nhé!",
            "actions": _default_chat_actions(),
        })

    # Lệnh dừng/reset
    if msg_lower in ['stop', 'dừng', 'thoát', 'reset']:
        sess['pending'] = None
        return jsonify({
            "reply": "Ok bé! Robo đã dừng bài luyện. Bé muốn luyện gì tiếp?",
            "actions": _default_chat_actions(),
        })

    # Ưu tiên chế độ dịch nếu bé hỏi rõ "dịch"
    if 'dịch' in msg_lower or 'nghĩa là' in msg_lower or 'tiếng anh là' in msg_lower or 'tiếng việt là' in msg_lower:
        clean_text = clean_input(raw_msg)
        if not clean_text:
            return jsonify({"reply": "Bé muốn dịch từ/câu gì? Gõ: Dịch ...", "actions": _default_chat_actions()})

        is_content_vietnamese = is_vietnamese(clean_text)
        target_lang = 'en'
        if "nghĩa là" in msg_lower or "tiếng việt" in msg_lower:
            target_lang = 'vi'
        elif "tiếng anh" in msg_lower:
            target_lang = 'en'
        else:
            if not is_content_vietnamese:
                target_lang = 'vi'

        trans = perform_translation(clean_text, target_lang)
        if target_lang == 'en':
            response = f"📖 '{clean_text}' tiếng Anh là: <b>{trans}</b>"
        else:
            response = f"📖 '{clean_text}' nghĩa là: <b>{trans}</b>"
        return jsonify({"reply": response, "actions": _default_chat_actions()})

    # Xác định topic hiện hành
    grade_id = sess.get('gradeId')
    topic_id = sess.get('topicId')
    topic = _get_topic_safe(grade_id, topic_id) if grade_id and topic_id else None

    # Lệnh bắt đầu luyện
    start_vocab = ('từ vựng' in msg_lower) or ('vocab' in msg_lower)
    start_grammar = ('ngữ pháp' in msg_lower) or ('grammar' in msg_lower) or (msg_lower.startswith('viết câu'))
    start_pronounce = ('phát âm' in msg_lower) or ('luyện nói' in msg_lower) or ('pronounce' in msg_lower)
    start_help = msg_lower in ['help', 'giúp', 'giúp đỡ', 'hướng dẫn']

    if start_help:
        return jsonify({
            "reply": (
                "Bé có thể:\n"
                "<br>- Gõ <b>từ vựng</b>: Robo hỏi nghĩa → bé trả lời tiếng Anh"
                "<br>- Gõ <b>ngữ pháp</b>: Robo cho câu tiếng Việt → bé viết câu tiếng Anh"
                "<br>- Gõ <b>phát âm</b>: Robo đưa từ → bé bấm nút micro để đọc"
                "<br><small>Mẹo: Hãy chọn 1 chủ đề (Lớp/Topic) ở màn hình chính để Robo hỏi đúng bài đang học.</small>"
            ),
            "actions": _default_chat_actions(),
        })

    if start_vocab:
        if not topic:
            return jsonify({
                "reply": "Bé hãy chọn 1 chủ đề ở màn hình chính trước nhé (Lớp → Topic). Sau đó gõ lại 'từ vựng'.",
                "actions": _default_chat_actions(),
            })
        q = _pick_vocab_question(topic)
        if not q:
            return jsonify({"reply": "Chủ đề này chưa có từ vựng để luyện.", "actions": _default_chat_actions()})
        sess['pending'] = q
        return jsonify({
            "reply": f"🧩 <b>Từ vựng</b>: Tiếng Anh của '<b>{q['vi']}</b>' là gì?",
            "actions": [
                {'action': 'start_vocab', 'label': 'Câu khác'},
                {'action': 'start_pronounce', 'label': 'Luyện phát âm'},
                {'action': 'stop', 'label': 'Dừng'},
            ],
        })

    if start_grammar:
        if not topic:
            return jsonify({
                "reply": "Bé hãy chọn 1 chủ đề ở màn hình chính trước nhé (Lớp → Topic). Sau đó gõ lại 'ngữ pháp'.",
                "actions": _default_chat_actions(),
            })
        q = _pick_grammar_question(topic)
        if not q:
            return jsonify({"reply": "Chủ đề này chưa có bài ngữ pháp để luyện.", "actions": _default_chat_actions()})
        sess['pending'] = q
        return jsonify({
            "reply": f"📝 <b>Ngữ pháp</b>: Viết câu tiếng Anh cho: '<b>{q['prompt_vi']}</b>'",
            "actions": [
                {'action': 'start_grammar', 'label': 'Câu khác'},
                {'action': 'stop', 'label': 'Dừng'},
            ],
        })

    if start_pronounce:
        if not topic:
            return jsonify({
                "reply": "Bé hãy chọn 1 chủ đề ở màn hình chính trước nhé (Lớp → Topic). Sau đó gõ lại 'phát âm'.",
                "actions": _default_chat_actions(),
            })
        q = _pick_vocab_question(topic)
        if not q:
            return jsonify({"reply": "Chủ đề này chưa có từ để luyện phát âm.", "actions": _default_chat_actions()})
        phon = ''
        try:
            phon = PHONETIC_CACHE.get(_normalize_key(q['en']), '')
            if not phon:
                phon = _fetch_phonetic_from_dictionary_api(q['en'])
                PHONETIC_CACHE[_normalize_key(q['en'])] = phon
        except Exception:
            phon = ''

        sess['pending'] = {
            'type': 'pronounce',
            'vocabIndex': q['vocabIndex'],
            'en': q['en'],
            'vi': q['vi'],
        }
        ipa = f" <span class='text-slate-500'>({phon})</span>" if phon else ''
        return jsonify({
            "reply": f"🎤 <b>Phát âm</b>: Bé hãy đọc từ <b>{q['en']}</b>{ipa}. Bấm nút micro bên dưới để đọc nhé!",
            "actions": [
                {'action': 'pronounce_mic', 'label': '🎤 Bấm để nói', 'target': q['en']},
                {'action': 'tts', 'label': '🔊 Nghe mẫu', 'target': q['en']},
                {'action': 'start_pronounce', 'label': 'Từ khác'},
                {'action': 'stop', 'label': 'Dừng'},
            ],
        })

    # Nếu đang có câu hỏi chờ trả lời
    pending = sess.get('pending') if isinstance(sess, dict) else None
    if isinstance(pending, dict) and pending.get('type') == 'vocab':
        user = _normalize_en_answer(raw_msg)
        correct = _normalize_en_answer(pending.get('en', ''))
        sim = _similarity(user, correct)
        is_correct = (user == correct) or (sim >= 0.88)
        if is_correct:
            reply = f"✅ Đúng rồi! Đáp án: <b>{pending.get('en')}</b>"
        else:
            reply = (
                f"❌ Chưa đúng. Bé trả lời: <b>{raw_msg}</b>"
                f"<br>Đáp án đúng: <b>{pending.get('en')}</b>"
            )

        # Ghi lịch sử (không cộng điểm theo localStorage; chỉ lưu log)
        try:
            qid = f"chat::vocab::{grade_id}::{topic_id}::{pending.get('vocabIndex')}::{_normalize_key(pending.get('en'))}"
            save_to_history(
                "Chat Vocab",
                f"Tiếng Anh của '{pending.get('vi')}'",
                raw_msg,
                100 if is_correct else 0,
                is_correct,
                question_id=qid,
                base_score=100 if is_correct else 0,
                counted=False,
                context={"gradeId": grade_id, "topicId": topic_id, "category": "chat_vocab", "itemId": pending.get('vocabIndex')},
            )
        except Exception:
            pass

        # Tự ra câu tiếp theo
        sess['pending'] = None
        return jsonify({
            "reply": reply + "<br><small>Muốn làm tiếp: bấm 'Câu khác' hoặc gõ 'từ vựng'.</small>",
            "actions": [
                {'action': 'start_vocab', 'label': 'Câu khác'},
                {'action': 'start_pronounce', 'label': 'Luyện phát âm'},
                {'action': 'stop', 'label': 'Dừng'},
            ],
        })

    if isinstance(pending, dict) and pending.get('type') == 'grammar':
        scored = _score_grammar_like_check_api(raw_msg, pending.get('answer', ''))
        try:
            qid = f"chat::grammar::{grade_id}::{topic_id}::{pending.get('grammarIndex')}"
            save_to_history(
                "Chat Grammar",
                f"Viết câu: {pending.get('prompt_vi')}",
                raw_msg,
                int(scored.get('score') or 0),
                bool(scored.get('is_correct')),
                question_id=qid,
                base_score=int(scored.get('score') or 0),
                counted=False,
                context={"gradeId": grade_id, "topicId": topic_id, "category": "chat_grammar", "itemId": pending.get('grammarIndex')},
            )
        except Exception:
            pass
        sess['pending'] = None
        reply = f"{scored.get('message','')}" + (f"<br>{scored.get('suggestion','')}" if scored.get('suggestion') else '')
        return jsonify({
            "reply": reply + "<br><small>Muốn làm tiếp: bấm 'Câu khác' hoặc gõ 'ngữ pháp'.</small>",
            "actions": [
                {'action': 'start_grammar', 'label': 'Câu khác'},
                {'action': 'stop', 'label': 'Dừng'},
            ],
        })

    # Mặc định: nhắc hướng dẫn
    return jsonify({
        "reply": "Robo có thể luyện <b>từ vựng</b>, <b>ngữ pháp</b>, <b>phát âm</b>. Bé muốn luyện phần nào?",
        "actions": _default_chat_actions(),
    })

if __name__ == '__main__':
    # debug=True + reloader sẽ import app 2 lần -> làm startup chậm.
    app.run(debug=True, use_reloader=False)