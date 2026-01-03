let currentData = null;
let currentIndex = 0;
let grammarIndex = 0;
let writingMode = 'vocab';
let currentGradeId = null;
let currentTopicId = null;
let selectedMode = null; // 'self' | 'chat' | null

const PHONETIC_CACHE = new Map();

function getPhoneticCached(word) {
    const key = String(word || '').trim().toLowerCase();
    if (!key) return Promise.resolve('');

    if (PHONETIC_CACHE.has(key)) {
        return Promise.resolve(PHONETIC_CACHE.get(key) || '');
    }

    return fetch(`/api/phonetic?word=${encodeURIComponent(word)}`)
        .then(r => r.json())
        .then(d => {
            const phon = (d && typeof d.phonetic === 'string') ? d.phonetic : '';
            PHONETIC_CACHE.set(key, phon);
            return phon;
        })
        .catch(() => {
            PHONETIC_CACHE.set(key, '');
            return '';
        });
}

const SCORE_STORAGE_KEY = 'robo_english_scores_v1';
const TOPIC_MAX_SCORE = 100;

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = new SpeechRecognition ? new SpeechRecognition() : null;
if(recognition) { recognition.lang = 'en-US'; recognition.continuous = false; }

function setChatPanelVisible(visible) {
    const panel = document.getElementById('chat-panel');
    if (!panel) return;
    panel.classList.toggle('hidden', !visible);
}

function setSelfLearningVisible(visible) {
    const tabs = document.getElementById('self-learning-tabs');
    const content = document.getElementById('self-learning-content');
    if (tabs) tabs.classList.toggle('hidden', !visible);
    if (content) content.classList.toggle('hidden', !visible);
}

window.onload = () => {
    setChatPanelVisible(false);
    loadCurriculum();
};

function loadScoreState() {
    try {
        const raw = localStorage.getItem(SCORE_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object') return { topics: {} };
        if (!parsed.topics || typeof parsed.topics !== 'object') return { topics: {} };
        return parsed;
    } catch {
        return { topics: {} };
    }
}

function saveScoreState(state) {
    localStorage.setItem(SCORE_STORAGE_KEY, JSON.stringify(state));
}

function getTopicKey(gradeId, topicId) {
    return `${gradeId}::${topicId}`;
}

function ensureTopicProgress(state, gradeId, topicId) {
    const key = getTopicKey(gradeId, topicId);
    if (!state.topics[key]) {
        state.topics[key] = {
            score: 0,
            completed: {
                speaking: [],
                writing: [],
                grammar: [],
                quiz: [],
                missing: [],
            },
        };
    }
    if (typeof state.topics[key].score !== 'number') state.topics[key].score = 0;
    if (!state.topics[key].completed || typeof state.topics[key].completed !== 'object') {
        state.topics[key].completed = { speaking: [], writing: [], grammar: [], quiz: [], missing: [] };
    }
    for (const cat of ['speaking', 'writing', 'grammar', 'quiz', 'missing']) {
        if (!Array.isArray(state.topics[key].completed[cat])) state.topics[key].completed[cat] = [];
    }
    return state.topics[key];
}

function clampScore(score) {
    if (!Number.isFinite(score)) return 0;
    return Math.max(0, Math.min(TOPIC_MAX_SCORE, score));
}

function getTotalScore() {
    const state = loadScoreState();
    const sum = Object.values(state.topics).reduce((acc, t) => acc + (typeof t.score === 'number' ? t.score : 0), 0);
    return Math.round(sum);
}

function renderTotalScore() {
    document.getElementById('total-score').innerText = String(getTotalScore());
}

function getTopicScore(gradeId, topicId) {
    const state = loadScoreState();
    const topic = ensureTopicProgress(state, gradeId, topicId);
    return Math.round(clampScore(topic.score));
}

function getPerItemPoints(category, topicData) {
    const vocabCount = Array.isArray(topicData?.vocab) ? topicData.vocab.length : 0;
    const grammarCount = Array.isArray(topicData?.grammar) ? topicData.grammar.length : 0;
    const quizCount = Array.isArray(topicData?.quiz) ? topicData.quiz.length : 0;

    const counts = {
        speaking: vocabCount,
        writing: vocabCount,
        grammar: grammarCount,
        quiz: quizCount,
        missing: vocabCount,
    };

    const totalItems = Object.values(counts).reduce((acc, c) => acc + (c > 0 ? c : 0), 0);
    if (totalItems <= 0) return 0;
    if (!counts[category] || counts[category] <= 0) return 0;

    return TOPIC_MAX_SCORE / totalItems;
}

function normalizeTopicScoreIfComplete(topicProgress, topicData) {
    const vocabCount = Array.isArray(topicData?.vocab) ? topicData.vocab.length : 0;
    const grammarCount = Array.isArray(topicData?.grammar) ? topicData.grammar.length : 0;
    const quizCount = Array.isArray(topicData?.quiz) ? topicData.quiz.length : 0;

    const totalItems =
        (vocabCount > 0 ? vocabCount : 0) * 3 +
        (grammarCount > 0 ? grammarCount : 0) +
        (quizCount > 0 ? quizCount : 0);
    if (totalItems <= 0) return;

    const doneCount =
        (Array.isArray(topicProgress.completed.speaking) ? topicProgress.completed.speaking.length : 0) +
        (Array.isArray(topicProgress.completed.writing) ? topicProgress.completed.writing.length : 0) +
        (Array.isArray(topicProgress.completed.grammar) ? topicProgress.completed.grammar.length : 0) +
        (Array.isArray(topicProgress.completed.quiz) ? topicProgress.completed.quiz.length : 0) +
        (Array.isArray(topicProgress.completed.missing) ? topicProgress.completed.missing.length : 0);

    if (doneCount >= totalItems) {
        topicProgress.score = TOPIC_MAX_SCORE;
    }
}

function awardTopicPointsOnce(category, itemId) {
    if (!currentGradeId || !currentTopicId || !currentData) return;
    const state = loadScoreState();
    const topic = ensureTopicProgress(state, currentGradeId, currentTopicId);

    const completedList = topic.completed[category];
    if (!completedList) return;
    if (completedList.includes(itemId)) {
        renderTotalScore();
        return;
    }

    completedList.push(itemId);
    const delta = getPerItemPoints(category, currentData);
    topic.score = clampScore(topic.score + delta);
    normalizeTopicScoreIfComplete(topic, currentData);
    saveScoreState(state);
    renderTotalScore();
}

// --- HÀM TTS MỚI (Dùng gTTS từ Server) ---
function playTTS(text) {
    const audio = document.getElementById('audio-player');
    // Gọi API backend
    audio.src = `/api/tts?text=${encodeURIComponent(text)}`;
    audio.play();
}

// Logic chuyển Tab
function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.getElementById(`tab-content-${tabName}`).classList.remove('hidden');
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('tab-active'));
    document.getElementById(`btn-${tabName}`).classList.add('tab-active');
}

async function loadCurriculum() {
    renderTotalScore();
    const res = await fetch('/api/curriculum');
    const data = await res.json();
    const list = document.getElementById('curriculum-list');
    list.innerHTML = '';
    for (const [gradeKey, gradeVal] of Object.entries(data)) {
        let topicsHtml = '';
        for (const [topicKey, topicVal] of Object.entries(gradeVal.topics)) {
            const topicScore = getTopicScore(gradeKey, topicKey);
            topicsHtml += `<div onclick="loadTopic('${gradeKey}', '${topicKey}')" class="flex items-center gap-3 p-3 bg-slate-50 rounded-xl cursor-pointer hover:bg-blue-50 border border-slate-100 transition group"><div class="w-10 h-10 bg-white text-blue-600 rounded-lg flex items-center justify-center font-bold shadow-sm group-hover:scale-110 transition">${topicVal.title.charAt(0)}</div><span class="font-bold text-slate-700 group-hover:text-blue-700 transition">${topicVal.title}</span><span class="ml-auto text-xs font-black text-blue-700 bg-blue-50 border border-blue-100 px-2.5 py-1 rounded-full">${topicScore}/100</span><i class="fas fa-chevron-right ml-2 text-slate-300"></i></div>`;
        }
        list.innerHTML += `<div class="bg-white p-5 rounded-2xl shadow-sm border border-slate-100"><h3 class="text-xl font-black text-blue-600 mb-4 uppercase">${gradeVal.title}</h3><div class="space-y-2">${topicsHtml}</div></div>`;
    }
}

async function loadTopic(gradeId, topicId) {
    const res = await fetch(`/api/topic/${gradeId}/${topicId}`);
    currentData = await res.json();
    currentGradeId = gradeId;
    currentTopicId = topicId;
    renderTotalScore();
    document.getElementById('current-topic-title').innerText = currentData.title;
    const selectedTitleEl = document.getElementById('selected-topic-title');
    if (selectedTitleEl) selectedTitleEl.innerText = currentData.title || '';
    selectedMode = null;
    setChatPanelVisible(false);
    showScreen('mode');
    currentIndex = 0;
    grammarIndex = 0;
    writingMode = 'vocab';
    renderVocab(); setupSpeaking(); setupWriting(); renderQuiz();
    switchTab('vocab');
}

function chooseMode(mode) {
    if (mode === 'self') {
        selectedMode = 'self';
        setSelfLearningVisible(true);
        setChatPanelVisible(false);
        showScreen('learn');
        switchTab('vocab');
        return;
    }
    if (mode === 'chat') {
        selectedMode = 'chat';
        setSelfLearningVisible(false);
        setChatPanelVisible(true);
        // Go to learn screen and show chat panel (hide mode selection UI).
        showScreen('learn');
        switchTab('vocab');
        ensureDefaultChatActions();
        const input = document.getElementById('chat-input');
        if (input) input.focus();
    }
}

function showScreen(name) {
    document.getElementById('screen-home').classList.toggle('hidden', name !== 'home');
    document.getElementById('screen-learn').classList.toggle('hidden', name !== 'learn');
    const modeEl = document.getElementById('screen-mode');
    if (modeEl) modeEl.classList.toggle('hidden', name !== 'mode');
    if (name === 'home') {
        selectedMode = null;
        setChatPanelVisible(false);
        loadCurriculum();
    }
}

function goToModeSelection() {
    // If no topic is selected yet, just go home.
    if (!currentData || !currentGradeId || !currentTopicId) {
        showScreen('home');
        return;
    }
    selectedMode = null;
    setChatPanelVisible(false);
    setSelfLearningVisible(true);
    showScreen('mode');
}

// --- Render Functions ---
function renderVocab() {
    const container = document.getElementById('content-vocab');
    container.innerHTML = currentData.vocab.map((word, idx) => `
        <div onclick="playTTS('${word.en}')" class="bg-slate-50 hover:bg-white border-2 border-transparent hover:border-blue-400 cursor-pointer rounded-2xl p-4 flex flex-col items-center text-center transition shadow-sm group">
            <div class="text-5xl mb-3 transform group-hover:scale-110 transition">${word.img}</div>
            <div class="font-bold text-lg text-slate-800">${word.en}</div>
            <div class="text-sm text-slate-500 font-bold" id="vocab-phonetic-${idx}"></div>
            <div class="text-sm text-slate-500">${word.vi}</div>
        </div>
    `).join('');

    // Fill phonetic text asynchronously (small list => ok)
    currentData.vocab.forEach((word, idx) => {
        const el = document.getElementById(`vocab-phonetic-${idx}`);
        if (!el || !word?.en) return;
        el.innerText = '';
        getPhoneticCached(word.en).then(phon => {
            // Ensure still the same topic/data
            const cur = currentData?.vocab?.[idx]?.en;
            if (cur === word.en) el.innerText = phon || '';
        });
    });
}

// Speaking Logic
function setupSpeaking() { updateSpeakCard(); }
function updateSpeakCard() {
    const word = currentData.vocab[currentIndex];
    document.getElementById('speak-img').innerText = word.img;
    document.getElementById('speak-word').innerText = word.en;
    const phoneticEl = document.getElementById('speak-phonetic');
    if (phoneticEl) phoneticEl.innerText = '';
    document.getElementById('speak-meaning').innerText = word.vi;
    document.getElementById('speak-status').innerText = "Bấm micro để đọc";
    document.getElementById('speak-status').className = "text-lg font-bold text-slate-500 bg-slate-100 px-4 py-2 rounded-lg";
    document.getElementById('speak-suggestion').classList.add('hidden'); // Ẩn gợi ý cũ

    // Khôi phục hiển thị phiên âm (IPA)
    if (phoneticEl && word?.en) {
        getPhoneticCached(word.en).then(phon => {
            if (currentData?.vocab?.[currentIndex]?.en === word.en) {
                phoneticEl.innerText = phon || '';
            }
        });
    }
}
function toggleMic() {
    if(!recognition) { alert("Lỗi Mic"); return; }
    const btn = document.getElementById('mic-btn');
    recognition.start();
    btn.classList.add('animate-pulse', 'bg-red-500');
    document.getElementById('speak-status').innerText = "Đang nghe...";
    
    recognition.onresult = async (e) => {
        const userSaid = e.results[0][0].transcript;
        const correctWord = currentData.vocab[currentIndex].en;
        const res = await fetch('/api/check', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                mode: 'speaking',
                user_answer: userSaid,
                correct_answer: correctWord,
                question_text: correctWord,
                context: {
                    gradeId: currentGradeId,
                    topicId: currentTopicId,
                    category: 'speaking',
                    itemId: currentIndex,
                },
            })
        });
        const result = await res.json();
        
        document.getElementById('speak-status').innerHTML = result.message;
        document.getElementById('speak-status').className = result.is_correct ? "text-lg font-bold text-green-600" : "text-lg font-bold text-red-500";
        
        // Hiển thị gợi ý sửa lỗi
        if (result.suggestion) {
            const suggBox = document.getElementById('speak-suggestion');
            suggBox.classList.remove('hidden');
            suggBox.innerHTML = `<b>💡 Gợi ý:</b> ${result.suggestion}`;
        }

        if(result.is_correct) { awardTopicPointsOnce('speaking', currentIndex); playTTS("Excellent!"); setTimeout(nextSpeak, 2000); }
        else { playTTS("Try again!"); }
        
        btn.classList.remove('animate-pulse', 'bg-red-500');
    };
}
function nextSpeak() { if(currentIndex < currentData.vocab.length-1) { currentIndex++; updateSpeakCard(); } }
function prevSpeak() { if(currentIndex > 0) { currentIndex--; updateSpeakCard(); } }

// Writing Logic
function setupWriting() { updateWriteCard(); }
function updateWriteCard() {
    const suggestion = document.getElementById('write-suggestion');
    suggestion.classList.add('hidden');
    suggestion.innerHTML = '';
    document.getElementById('write-feedback').innerText = '';
    document.getElementById('write-input').value = '';

    if (writingMode === 'grammar') {
        const hasGrammar = Array.isArray(currentData?.grammar) && currentData.grammar.length > 0;
        if (!hasGrammar) {
            document.getElementById('write-img').innerText = '📝';
            document.getElementById('write-label').innerText = 'Chủ đề này chưa có bài viết câu.';
            document.getElementById('write-meaning').innerText = '';
            return;
        }

        const item = currentData.grammar[grammarIndex];
        document.getElementById('write-img').innerText = '📝';
        document.getElementById('write-label').innerText = 'Viết câu tiếng Anh cho:';
        document.getElementById('write-meaning').innerText = item.prompt_vi;
        document.getElementById('write-input').placeholder = 'Nhập câu tiếng Anh...';
    } else {
        const word = currentData.vocab[currentIndex];
        document.getElementById('write-img').innerText = word.img || '❓';
        document.getElementById('write-label').innerText = 'Viết từ tiếng Anh của:';
        document.getElementById('write-meaning').innerText = word.vi;
        document.getElementById('write-input').placeholder = 'Nhập đáp án...';
    }

    document.getElementById('write-input').focus();
}

function setWritingMode(mode) {
    writingMode = mode === 'grammar' ? 'grammar' : 'vocab';

    const btnVocab = document.getElementById('btn-write-vocab');
    const btnGrammar = document.getElementById('btn-write-grammar');

    const activeClasses = ['bg-orange-600', 'text-white', 'border-orange-600'];
    const inactiveClasses = ['bg-white', 'border-orange-200', 'text-orange-700'];

    const setActive = (btn) => {
        btn.classList.remove(...inactiveClasses);
        btn.classList.add(...activeClasses);
    };
    const setInactive = (btn) => {
        btn.classList.remove(...activeClasses);
        btn.classList.add(...inactiveClasses);
    };

    if (writingMode === 'grammar') {
        setInactive(btnVocab);
        setActive(btnGrammar);
    } else {
        setActive(btnVocab);
        setInactive(btnGrammar);
    }

    updateWriteCard();
}
async function checkWriting() {
    const input = document.getElementById('write-input').value;
    const payload = {
        mode: 'writing',
        user_answer: input,
        correct_answer: '',
        question_text: '',
        context: {
            gradeId: currentGradeId,
            topicId: currentTopicId,
            category: writingMode === 'grammar' ? 'grammar' : 'writing',
            itemId: writingMode === 'grammar' ? grammarIndex : currentIndex,
        },
    };

    if (writingMode === 'grammar') {
        const hasGrammar = Array.isArray(currentData?.grammar) && currentData.grammar.length > 0;
        if (!hasGrammar) return;
        payload.mode = 'grammar';
        payload.correct_answer = currentData.grammar[grammarIndex].answer;
        payload.question_text = currentData.grammar[grammarIndex].prompt_vi;
    } else {
        payload.correct_answer = currentData.vocab[currentIndex].en;
        payload.question_text = currentData.vocab[currentIndex].vi;
    }

    const res = await fetch('/api/check', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    });
    const result = await res.json();
    const fb = document.getElementById('write-feedback');
    fb.innerText = result.message;
    fb.className = result.is_correct ? "mt-4 font-bold text-xl text-green-600" : "mt-4 font-bold text-xl text-red-500";

    const sugg = document.getElementById('write-suggestion');
    if (result.suggestion) {
        sugg.classList.remove('hidden');
        sugg.innerHTML = `<b>💡 Gợi ý:</b> ${result.suggestion}`;
    } else {
        sugg.classList.add('hidden');
        sugg.innerHTML = '';
    }

    if(result.is_correct) {
        if (writingMode === 'vocab') {
            awardTopicPointsOnce('writing', currentIndex);
        } else {
            awardTopicPointsOnce('grammar', grammarIndex);
        }
        playTTS("Correct!");
    }
}
function nextWrite() {
    if (writingMode === 'grammar') {
        const hasGrammar = Array.isArray(currentData?.grammar) && currentData.grammar.length > 0;
        if (!hasGrammar) return;
        if (grammarIndex < currentData.grammar.length - 1) {
            grammarIndex++;
            updateWriteCard();
        } else {
            alert("Hết bài viết câu!");
        }
        return;
    }

    if(currentIndex < currentData.vocab.length-1) {
        currentIndex++;
        updateWriteCard();
    } else {
        alert("Hết bài!");
    }
}

// Quiz Logic
function renderQuiz() {
    const container = document.getElementById('quiz-container');
    const hasQuiz = Array.isArray(currentData?.quiz) && currentData.quiz.length > 0;
    const hasVocab = Array.isArray(currentData?.vocab) && currentData.vocab.length > 0;
    if (!hasQuiz && !hasVocab) {
        container.innerHTML = "Chưa có bài kiểm tra";
        return;
    }

    let html = '';

    // --- Trắc nghiệm ---
    if (hasQuiz) {
        html += currentData.quiz.map((q, qIdx) => {
            const questionHtml = escapeHtml(q.question);
            const opts = Array.isArray(q.options) ? q.options : [];
            const optsHtml = opts.map((opt, optIdx) => {
                return `<button type="button" data-quiz-q="${qIdx}" data-quiz-opt="${optIdx}" class="quiz-opt-btn w-full text-left px-4 py-2 bg-white rounded-lg border hover:border-blue-400">${escapeHtml(opt)}</button>`;
            }).join('');

            return `
                <div class="p-4 border border-slate-200 rounded-xl bg-slate-50">
                    <p class="font-bold mb-3">Câu ${qIdx + 1}: ${questionHtml}</p>
                    <div class="grid grid-cols-1 gap-2">${optsHtml}</div>
                </div>
            `;
        }).join('');
    }

    // --- Điền chữ còn thiếu (gõ trực tiếp vào chữ bị thiếu) ---
    if (hasVocab) {
        html += `
            <div class="p-4 border border-slate-200 rounded-xl bg-white">
                <div class="font-black text-slate-800 mb-3">Điền chữ còn thiếu</div>
                <div class="space-y-4">
                    ${currentData.vocab.map((w, idx) => `
                        <div class="p-4 border border-slate-200 rounded-xl bg-slate-50">
                            <div class="text-sm text-slate-600 font-bold mb-2">${w.vi}</div>
                            <div class="flex items-center justify-between gap-3 flex-wrap">
                                <div id="ml-word-${idx}" class="text-2xl font-black text-slate-800 tracking-wider"></div>
                                <button type="button" id="ml-btn-${idx}" data-ml-check="${idx}" class="px-4 py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700">Kiểm tra</button>
                            </div>
                            <div id="ml-feedback-${idx}" class="mt-2 text-sm font-bold"></div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    html += `<button onclick="finishQuiz()" class="w-full py-3 bg-blue-600 text-white font-bold rounded-xl mt-4">Nộp Bài</button>`;
    container.innerHTML = html;
    document.getElementById('quiz-result').classList.add('hidden');
    container.classList.remove('hidden');

    // Render chữ bị thiếu sau khi DOM đã có
    if (hasVocab) {
        currentData.vocab.forEach((w, idx) => {
            const mount = document.getElementById(`ml-word-${idx}`);
            if (!mount) return;
            mount.innerHTML = buildMissingLettersHtml(String(w.en || ''), idx);
        });
    }

    initTestEventDelegation();
}

function initTestEventDelegation() {
    const container = document.getElementById('quiz-container');
    if (!container || container.dataset.handlersAttached === '1') return;

    container.addEventListener('click', (e) => {
        const quizBtn = e.target.closest('button[data-quiz-q]');
        if (quizBtn) {
            const qIdx = Number(quizBtn.getAttribute('data-quiz-q'));
            const optIdx = Number(quizBtn.getAttribute('data-quiz-opt'));
            if (Number.isFinite(qIdx) && Number.isFinite(optIdx)) {
                checkQuiz(quizBtn, qIdx, optIdx);
            }
            return;
        }

        const missingBtn = e.target.closest('button[data-ml-check]');
        if (missingBtn) {
            const idx = Number(missingBtn.getAttribute('data-ml-check'));
            if (Number.isFinite(idx)) {
                checkMissingLetters(idx);
            }
        }
    });

    container.dataset.handlersAttached = '1';
}

function pickMissingLetterPositions(word) {
    // Chỉ chọn ký tự chữ cái (A-Z). Không chọn khoảng trắng/ký tự đặc biệt.
    const chars = Array.from(word);
    const letterPositions = [];
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (/[a-zA-Z]/.test(c)) letterPositions.push(i);
    }
    if (letterPositions.length <= 2) return new Set();

    // Không ẩn chữ đầu và chữ cuối (nếu là chữ cái)
    const allowed = letterPositions.slice(1, -1);
    if (allowed.length <= 0) return new Set();

    // Số lượng chữ bị thiếu: tối thiểu 1, tối đa 3, theo độ dài
    const target = Math.max(1, Math.min(3, Math.floor(letterPositions.length / 3)));

    // Chọn ngẫu nhiên nhưng ổn định theo index (dùng seed đơn giản)
    // Để mỗi lần render không đổi quá nhiều gây khó chịu
    let seed = 0;
    for (const ch of word) seed = (seed + ch.charCodeAt(0)) % 997;

    const picked = new Set();
    let tries = 0;
    while (picked.size < target && tries < 50) {
        const pos = allowed[(seed + tries * 17) % allowed.length];
        picked.add(pos);
        tries++;
    }
    return picked;
}

function buildMissingLettersHtml(word, wordIndex) {
    const chars = Array.from(word);
    const missing = pickMissingLetterPositions(word);

    const parts = [];
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (missing.has(i)) {
            parts.push(`<input data-ml-idx="${wordIndex}" data-ml-pos="${i}" maxlength="1" inputmode="text" autocomplete="off" class="w-7 h-9 text-center border-2 border-slate-200 rounded-md outline-none focus:border-blue-500 bg-white font-black" oninput="onMissingLetterInput(event)" onkeydown="onMissingLetterKeyDown(event)" />`);
        } else {
            // Giữ nguyên khoảng trắng
            if (c === ' ') {
                parts.push(`<span class="inline-block w-3"></span>`);
            } else {
                parts.push(`<span class="inline-block px-0.5">${escapeHtml(c)}</span>`);
            }
        }
    }

    return `<div class="flex items-end flex-wrap gap-1">${parts.join('')}</div>`;
}

function escapeHtml(s) {
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function onMissingLetterInput(e) {
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;
    // Chỉ lấy 1 ký tự cuối
    if (input.value.length > 1) input.value = input.value.slice(-1);

    // Auto focus sang ô tiếp theo
    const idx = input.getAttribute('data-ml-idx');
    const pos = input.getAttribute('data-ml-pos');
    if (idx == null || pos == null) return;

    const inputs = Array.from(document.querySelectorAll(`input[data-ml-idx="${idx}"]`));
    inputs.sort((a, b) => Number(a.getAttribute('data-ml-pos')) - Number(b.getAttribute('data-ml-pos')));
    const curIndex = inputs.indexOf(input);
    if (curIndex >= 0 && curIndex < inputs.length - 1 && input.value) {
        inputs[curIndex + 1].focus();
        inputs[curIndex + 1].select();
    }
}

function onMissingLetterKeyDown(e) {
    const input = e.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (e.key !== 'Backspace' || input.value) return;

    const idx = input.getAttribute('data-ml-idx');
    if (idx == null) return;

    const inputs = Array.from(document.querySelectorAll(`input[data-ml-idx="${idx}"]`));
    inputs.sort((a, b) => Number(a.getAttribute('data-ml-pos')) - Number(b.getAttribute('data-ml-pos')));
    const curIndex = inputs.indexOf(input);
    if (curIndex > 0) {
        inputs[curIndex - 1].focus();
        inputs[curIndex - 1].select();
    }
}

async function checkMissingLetters(wordIndex) {
    const feedbackEl = document.getElementById(`ml-feedback-${wordIndex}`);
    const mount = document.getElementById(`ml-word-${wordIndex}`);
    if (!feedbackEl || !mount) return;

    const correctWord = currentData?.vocab?.[wordIndex]?.en;
    if (!correctWord) return;

    const original = String(correctWord || '');
    const chars = Array.from(original);
    const inputs = Array.from(mount.querySelectorAll('input[data-ml-idx]'));
    const byPos = new Map();
    for (const inp of inputs) {
        const pos = Number(inp.getAttribute('data-ml-pos'));
        byPos.set(pos, String(inp.value || '').trim());
    }

    // Ghép đáp án
    let answer = '';
    for (let i = 0; i < chars.length; i++) {
        if (byPos.has(i)) {
            answer += byPos.get(i) || '';
        } else {
            answer += chars[i];
        }
    }

    // Luôn gọi backend để chấm (đúng/sai) + đồng bộ logic "đúng rồi thì không cộng lại"
    try {
        const res = await fetch('/api/check', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                mode: 'writing',
                user_answer: answer,
                correct_answer: original,
                question_text: original,
                context: {
                    gradeId: currentGradeId,
                    topicId: currentTopicId,
                    category: 'missing',
                    itemId: wordIndex,
                },
            })
        });
        const result = await res.json();

        feedbackEl.innerHTML = result.message || (result.is_correct ? 'Đúng rồi! 🎉' : 'Chưa đúng, thử lại nhé!');
        feedbackEl.className = result.is_correct
            ? 'mt-2 text-sm font-bold text-green-600'
            : 'mt-2 text-sm font-bold text-red-500';

        if (result.is_correct) {
            if (!result.already_correct) {
                awardTopicPointsOnce('missing', wordIndex);
            }
            for (const inp of inputs) inp.disabled = true;
            const btn = document.getElementById(`ml-btn-${wordIndex}`);
            if (btn) btn.disabled = true;
            playTTS(original);
        }
    } catch {
        // Fallback khi lỗi mạng: vẫn chấm local
        const ok = answer.toLowerCase() === original.toLowerCase();
        feedbackEl.innerText = ok ? 'Đúng rồi! 🎉' : 'Chưa đúng, thử lại nhé!';
        feedbackEl.className = ok
            ? 'mt-2 text-sm font-bold text-green-600'
            : 'mt-2 text-sm font-bold text-red-500';
        if (ok) {
            awardTopicPointsOnce('missing', wordIndex);
            for (const inp of inputs) inp.disabled = true;
            const btn = document.getElementById(`ml-btn-${wordIndex}`);
            if (btn) btn.disabled = true;
            playTTS(original);
        }
    }
}
async function checkQuiz(btn, questionIndex, userChoice, correctAns, questionText) {
    // Backward compatibility if old signature is used
    if (typeof userChoice === 'number' && typeof correctAns === 'undefined') {
        const optIndex = userChoice;
        const q = currentData?.quiz?.[questionIndex];
        if (!q || !Array.isArray(q.options)) return;
        const choiceText = String(q.options[optIndex] ?? '').trim();
        const correctText = String(q.answer ?? '').trim();
        const qText = String(q.question ?? '').trim();
        return checkQuiz(btn, questionIndex, choiceText, correctText, qText);
    }

    const res = await fetch('/api/check', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            mode: 'quiz',
            user_answer: userChoice,
            correct_answer: correctAns,
            question_text: questionText,
            context: {
                gradeId: currentGradeId,
                topicId: currentTopicId,
                category: 'quiz',
                itemId: questionIndex,
            },
        })
    });
    const result = await res.json();
    const siblings = btn.parentElement.children;
    for(let sib of siblings) { sib.disabled = true; if(sib.innerText.trim() === correctAns) sib.classList.add('bg-green-100', 'border-green-500'); }
    if(result.is_correct) { btn.classList.add('bg-green-100', 'border-green-500'); awardTopicPointsOnce('quiz', questionIndex); } 
    else { btn.classList.add('bg-red-100', 'border-red-500'); }
}
function finishQuiz() {
    document.getElementById('quiz-container').classList.add('hidden');
    document.getElementById('quiz-result').classList.remove('hidden');
    document.getElementById('quiz-score-display').innerText = String(getTotalScore());
    playTTS("Good job!");
}
function resetQuiz() { renderQuiz(); }

// Chatbot Logic
function toggleChat() { 
    const win = document.getElementById('chat-window');
    if (!win) return;

    // If chat is embedded as a panel, keep it visible.
    if (win.classList.contains('chat-embedded')) {
        const input = document.getElementById('chat-input');
        if (input) input.focus();
        ensureDefaultChatActions();
        return;
    }

    win.classList.toggle('hidden-chat');
    if(!win.classList.contains('hidden-chat')) {
        const input = document.getElementById('chat-input');
        if (input) input.focus();
        ensureDefaultChatActions();
    }
}
async function sendChat() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if(!msg) return;
    appendMsg(msg, 'bg-blue-600 text-white self-end');
    input.value = '';
    try {
        const data = await sendChatPayload(msg);
        appendMsg(data.reply, 'bg-white text-slate-700 self-start border border-slate-200');
        renderChatActions(data.actions);
    } catch(e) { appendMsg("Lỗi mạng", 'bg-red-100 text-red-600'); }
}
function appendMsg(text, cls) {
    const div = document.createElement('div');
    div.className = `p-2 rounded-xl max-w-[85%] text-sm ${cls}`;
    div.innerHTML = text;
    document.getElementById('chat-messages').appendChild(div);
    document.getElementById('chat-messages').scrollTop = 9999;
}

// --- Chatbot Learning UI ---
const CHAT_CLIENT_ID_KEY = 'robo_chat_client_id_v1';

function getChatClientId() {
    try {
        const existing = localStorage.getItem(CHAT_CLIENT_ID_KEY);
        if (existing && String(existing).trim()) return String(existing).trim();
    } catch {}

    let id = '';
    try {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            id = window.crypto.randomUUID();
        }
    } catch {}
    if (!id) {
        id = `cid_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }

    try { localStorage.setItem(CHAT_CLIENT_ID_KEY, id); } catch {}
    return id;
}

function renderChatActions(actions) {
    const container = document.getElementById('chat-actions');
    if (!container) return;
    container.innerHTML = '';
    if (!Array.isArray(actions) || actions.length === 0) return;

    for (const a of actions) {
        if (!a || typeof a !== 'object') continue;
        const action = String(a.action || '').trim();
        const label = String(a.label || '').trim();
        const target = (typeof a.target === 'undefined') ? '' : String(a.target);
        if (!action || !label) continue;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chat-action-btn';
        btn.textContent = label;
        btn.dataset.action = action;
        btn.dataset.target = target;
        btn.onclick = () => handleChatAction(action, target);
        container.appendChild(btn);
    }
}

function actionToMessage(action) {
    switch (action) {
        case 'start_vocab': return 'từ vựng';
        case 'start_grammar': return 'ngữ pháp';
        case 'start_pronounce': return 'phát âm';
        case 'stop': return 'stop';
        default: return '';
    }
}

async function sendChatPayload(message) {
    const clientId = getChatClientId();
    const payload = {
        message,
        client_id: clientId,
        context: {
            gradeId: currentGradeId,
            topicId: currentTopicId,
        }
    };
    const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return await res.json();
}

function runSpeechOnce(onResult, onError) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
        onError && onError(new Error('SpeechRecognition not supported'));
        return;
    }
    const r = new SR();
    r.lang = 'en-US';
    r.continuous = false;
    r.interimResults = false;
    r.onresult = (e) => {
        try {
            const transcript = e.results?.[0]?.[0]?.transcript || '';
            onResult && onResult(String(transcript));
        } catch (err) {
            onError && onError(err);
        }
    };
    r.onerror = (e) => onError && onError(e);
    r.onend = () => {};
    try { r.start(); } catch (err) { onError && onError(err); }
}

async function handleChatAction(action, target) {
    if (action === 'tts') {
        if (target) playTTS(target);
        return;
    }
    if (action === 'pronounce_mic') {
        await startChatPronunciation(target);
        return;
    }

    const msg = actionToMessage(action);
    if (!msg) return;

    // Gửi như một "lệnh" (không append như user chat thường)
    appendMsg(msg, 'bg-blue-600 text-white self-end');
    try {
        const data = await sendChatPayload(msg);
        appendMsg(data.reply, 'bg-white text-slate-700 self-start border border-slate-200');
        renderChatActions(data.actions);
    } catch {
        appendMsg('Lỗi mạng', 'bg-red-100 text-red-600');
    }
}

async function startChatPronunciation(targetWord) {
    const word = String(targetWord || '').trim();
    if (!word) return;

    appendMsg('🎤 (Bé bấm micro và đọc nhé...)', 'bg-blue-600 text-white self-end');

    runSpeechOnce(async (transcript) => {
        const userSaid = String(transcript || '').trim();
        if (!userSaid) {
            appendMsg('Robo chưa nghe rõ. Bé thử lại nhé!', 'bg-white text-slate-700 self-start border border-slate-200');
            return;
        }

        appendMsg(userSaid, 'bg-blue-600 text-white self-end');
        try {
            const res = await fetch('/api/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: 'speaking',
                    user_answer: userSaid,
                    correct_answer: word,
                    question_text: word,
                    context: {
                        gradeId: currentGradeId,
                        topicId: currentTopicId,
                        category: 'chat_pronounce',
                        itemId: `chat:${word}`,
                    },
                })
            });
            const result = await res.json();
            let reply = result.message || '';
            if (result.suggestion) reply += `<br><small>${result.suggestion}</small>`;
            appendMsg(reply || 'Ok!', 'bg-white text-slate-700 self-start border border-slate-200');
        } catch {
            appendMsg('Lỗi mạng', 'bg-red-100 text-red-600');
        }
    }, () => {
        appendMsg('Trình duyệt không hỗ trợ micro hoặc bị chặn quyền.', 'bg-red-100 text-red-600');
    });
}

function ensureDefaultChatActions() {
    // Hiển thị nút mặc định khi mở chat lần đầu
    renderChatActions([
        { action: 'start_vocab', label: 'Luyện từ vựng' },
        { action: 'start_grammar', label: 'Luyện ngữ pháp' },
        { action: 'start_pronounce', label: 'Luyện phát âm' },
    ]);
}