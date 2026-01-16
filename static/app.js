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
const ATTEMPT_STORAGE_KEY = 'robo_english_attempts_v1';
const SCORE_WEIGHTS = {
    speaking: 25,
    writing: 25,
    test: 50,
};
const TOPIC_MAX_SCORE = SCORE_WEIGHTS.speaking + SCORE_WEIGHTS.writing + SCORE_WEIGHTS.test;

function loadAttemptState() {
    try {
        const raw = localStorage.getItem(ATTEMPT_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object') return { topics: {} };
        if (!parsed.topics || typeof parsed.topics !== 'object') return { topics: {} };
        return parsed;
    } catch {
        return { topics: {} };s 
    }
}

function saveAttemptState(state) {
    try {
        localStorage.setItem(ATTEMPT_STORAGE_KEY, JSON.stringify(state));
    } catch {}
}

function ensureTopicAttempt(state, gradeId, topicId) {
    if (!state || typeof state !== 'object') state = { topics: {} };
    if (!state.topics || typeof state.topics !== 'object') state.topics = {};

    const key = getTopicKey(gradeId, topicId);
    if (!state.topics[key] || typeof state.topics[key] !== 'object') {
        state.topics[key] = {
            writing: { vocab: {}, grammar: {} },
            test: { quiz: {}, missing: {}, finished: false },
        };
    }

    const t = state.topics[key];
    if (!t.writing || typeof t.writing !== 'object') t.writing = { vocab: {}, grammar: {} };
    if (!t.writing.vocab || typeof t.writing.vocab !== 'object') t.writing.vocab = {};
    if (!t.writing.grammar || typeof t.writing.grammar !== 'object') t.writing.grammar = {};

    if (!t.test || typeof t.test !== 'object') t.test = { quiz: {}, missing: {}, finished: false };
    if (!t.test.quiz || typeof t.test.quiz !== 'object') t.test.quiz = {};
    if (!t.test.missing || typeof t.test.missing !== 'object') t.test.missing = {};
    if (typeof t.test.finished !== 'boolean') t.test.finished = false;

    return t;
}

function getOrCreateCurrentTopicAttempt() {
    if (!currentGradeId || !currentTopicId) return null;
    const state = loadAttemptState();
    const topicAttempt = ensureTopicAttempt(state, currentGradeId, currentTopicId);
    saveAttemptState(state);
    return topicAttempt;
}

function clearCurrentTopicTestAttempt() {
    if (!currentGradeId || !currentTopicId) return;
    const state = loadAttemptState();
    const topicAttempt = ensureTopicAttempt(state, currentGradeId, currentTopicId);
    topicAttempt.test = { quiz: {}, missing: {}, finished: false };
    saveAttemptState(state);
}

function getWritingItemAttempt(topicAttempt, mode, itemId) {
    if (!topicAttempt) return null;
    const bucket = (mode === 'grammar') ? topicAttempt.writing.grammar : topicAttempt.writing.vocab;
    const key = String(itemId);
    if (!bucket[key] || typeof bucket[key] !== 'object') {
        bucket[key] = { value: '', result: null };
    }
    if (typeof bucket[key].value !== 'string') bucket[key].value = '';
    if (bucket[key].result && typeof bucket[key].result !== 'object') bucket[key].result = null;
    return bucket[key];
}

function persistCurrentWritingDraft(value) {
    if (!currentGradeId || !currentTopicId) return;
    const state = loadAttemptState();
    const topicAttempt = ensureTopicAttempt(state, currentGradeId, currentTopicId);
    const mode = (writingMode === 'grammar') ? 'grammar' : 'vocab';
    const itemId = (mode === 'grammar') ? grammarIndex : currentIndex;
    const item = getWritingItemAttempt(topicAttempt, mode, itemId);
    if (!item) return;
    item.value = String(value ?? '');
    saveAttemptState(state);
}

function persistCurrentWritingResult(result) {
    if (!currentGradeId || !currentTopicId) return;
    const state = loadAttemptState();
    const topicAttempt = ensureTopicAttempt(state, currentGradeId, currentTopicId);
    const mode = (writingMode === 'grammar') ? 'grammar' : 'vocab';
    const itemId = (mode === 'grammar') ? grammarIndex : currentIndex;
    const item = getWritingItemAttempt(topicAttempt, mode, itemId);
    if (!item) return;
    item.value = String(document.getElementById('write-input')?.value ?? item.value ?? '');
    item.result = {
        message: String(result?.message ?? ''),
        is_correct: !!result?.is_correct,
        suggestion: String(result?.suggestion ?? ''),
    };
    saveAttemptState(state);
}

function initWritingDraftPersistence() {
    const input = document.getElementById('write-input');
    if (!input || input.dataset.draftAttached === '1') return;
    input.addEventListener('input', () => {
        persistCurrentWritingDraft(input.value);
    });
    input.dataset.draftAttached = '1';
}

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
            sectionScores: {
                speaking: 0,
                writing: 0,
                test: 0,
            },
            attempted: {
                speaking: [],
                writing: [],
                grammar: [],
                quiz: [],
                missing: [],
            },
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
    if (!state.topics[key].sectionScores || typeof state.topics[key].sectionScores !== 'object') {
        state.topics[key].sectionScores = { speaking: 0, writing: 0, test: 0 };
    }
    for (const sec of ['speaking', 'writing', 'test']) {
        if (typeof state.topics[key].sectionScores[sec] !== 'number') state.topics[key].sectionScores[sec] = 0;
    }
    if (!state.topics[key].attempted || typeof state.topics[key].attempted !== 'object') {
        state.topics[key].attempted = { speaking: [], writing: [], grammar: [], quiz: [], missing: [] };
    }
    for (const cat of ['speaking', 'writing', 'grammar', 'quiz', 'missing']) {
        if (!Array.isArray(state.topics[key].attempted[cat])) state.topics[key].attempted[cat] = [];
    }
    if (!state.topics[key].completed || typeof state.topics[key].completed !== 'object') {
        state.topics[key].completed = { speaking: [], writing: [], grammar: [], quiz: [], missing: [] };
    }
    for (const cat of ['speaking', 'writing', 'grammar', 'quiz', 'missing']) {
        if (!Array.isArray(state.topics[key].completed[cat])) state.topics[key].completed[cat] = [];
    }
    return state.topics[key];
}

function clampScore(score, maxScore = TOPIC_MAX_SCORE) {
    if (!Number.isFinite(score)) return 0;
    const maxVal = Number.isFinite(maxScore) ? maxScore : TOPIC_MAX_SCORE;
    return Math.max(0, Math.min(maxVal, score));
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
    return Math.round(clampScore(topic.score, TOPIC_MAX_SCORE));
}

function getTopicSectionScore(gradeId, topicId, section) {
    const state = loadScoreState();
    const topic = ensureTopicProgress(state, gradeId, topicId);
    const maxScore = SCORE_WEIGHTS[section] ?? 0;
    const val = topic.sectionScores?.[section];
    return Math.round(clampScore(typeof val === 'number' ? val : 0, maxScore));
}

function getScoreSectionForCategory(category) {
    if (category === 'speaking') return 'speaking';
    if (category === 'writing' || category === 'grammar') return 'writing';
    if (category === 'quiz' || category === 'missing') return 'test';
    return null;
}

function getSectionMaxScore(section) {
    return SCORE_WEIGHTS[section] ?? 0;
}

function getSectionItemCount(section, topicData) {
    const vocabCount = Array.isArray(topicData?.vocab) ? topicData.vocab.length : 0;
    const grammarCount = Array.isArray(topicData?.grammar) ? topicData.grammar.length : 0;
    const quizCount = Array.isArray(topicData?.quiz) ? topicData.quiz.length : 0;

    if (section === 'speaking') return vocabCount;
    if (section === 'writing') return vocabCount + grammarCount;
    if (section === 'test') return quizCount + vocabCount;
    return 0;
}

function getPerItemPoints(category, topicData) {
    const section = getScoreSectionForCategory(category);
    if (!section) return 0;

    const sectionMax = getSectionMaxScore(section);
    const itemCount = getSectionItemCount(section, topicData);
    if (sectionMax <= 0 || itemCount <= 0) return 0;

    return sectionMax / itemCount;
}

function recomputeTopicScores(topicProgress, topicData) {
    if (!topicProgress || typeof topicProgress !== 'object') return;
    if (!topicProgress.sectionScores || typeof topicProgress.sectionScores !== 'object') {
        topicProgress.sectionScores = { speaking: 0, writing: 0, test: 0 };
    }

    const nextSectionScores = { speaking: 0, writing: 0, test: 0 };

    const completed = topicProgress.completed || {};
    const unique = (arr) => Array.from(new Set(Array.isArray(arr) ? arr : []));

    for (const itemId of unique(completed.speaking)) {
        nextSectionScores.speaking += getPerItemPoints('speaking', topicData);
    }

    for (const itemId of unique(completed.writing)) {
        nextSectionScores.writing += getPerItemPoints('writing', topicData);
    }
    for (const itemId of unique(completed.grammar)) {
        nextSectionScores.writing += getPerItemPoints('grammar', topicData);
    }

    for (const itemId of unique(completed.quiz)) {
        nextSectionScores.test += getPerItemPoints('quiz', topicData);
    }
    for (const itemId of unique(completed.missing)) {
        nextSectionScores.test += getPerItemPoints('missing', topicData);
    }

    nextSectionScores.speaking = clampScore(nextSectionScores.speaking, SCORE_WEIGHTS.speaking);
    nextSectionScores.writing = clampScore(nextSectionScores.writing, SCORE_WEIGHTS.writing);
    nextSectionScores.test = clampScore(nextSectionScores.test, SCORE_WEIGHTS.test);

    topicProgress.sectionScores.speaking = nextSectionScores.speaking;
    topicProgress.sectionScores.writing = nextSectionScores.writing;
    topicProgress.sectionScores.test = nextSectionScores.test;

    topicProgress.score = clampScore(
        nextSectionScores.speaking + nextSectionScores.writing + nextSectionScores.test,
        TOPIC_MAX_SCORE
    );
}

function _uniqueLen(arr) {
    return new Set(Array.isArray(arr) ? arr : []).size;
}

function markAttemptedOnce(category, itemId) {
    if (!currentGradeId || !currentTopicId) return;
    const state = loadScoreState();
    const topic = ensureTopicProgress(state, currentGradeId, currentTopicId);
    const list = topic.attempted?.[category];
    if (!Array.isArray(list)) return;
    if (list.includes(itemId)) return;
    list.push(itemId);
    saveScoreState(state);
}

function isAttemptedItem(category, itemId) {
    if (!currentGradeId || !currentTopicId) return false;
    const state = loadScoreState();
    const topic = ensureTopicProgress(state, currentGradeId, currentTopicId);
    const list = topic.attempted?.[category];
    if (!Array.isArray(list)) return false;
    return list.includes(itemId);
}

function setButtonLocked(btn, locked) {
    if (!btn) return;
    btn.disabled = !!locked;
    btn.classList.toggle('opacity-50', !!locked);
    btn.classList.toggle('cursor-not-allowed', !!locked);
}

function isSectionComplete(topicProgress, topicData, section) {
    // A section is considered "complete" when the learner has ATTEMPTED all items.
    // Wrong answers simply don't award points.
    const attempted = topicProgress?.attempted || {};
    const vocabCount = Array.isArray(topicData?.vocab) ? topicData.vocab.length : 0;
    const grammarCount = Array.isArray(topicData?.grammar) ? topicData.grammar.length : 0;
    const quizCount = Array.isArray(topicData?.quiz) ? topicData.quiz.length : 0;

    if (section === 'speaking') {
        if (vocabCount <= 0) return false;
        return _uniqueLen(attempted.speaking) >= vocabCount;
    }
    if (section === 'writing') {
        const total = vocabCount + grammarCount;
        if (total <= 0) return false;
        return _uniqueLen(attempted.writing) >= vocabCount && _uniqueLen(attempted.grammar) >= grammarCount;
    }
    if (section === 'test') {
        const total = vocabCount + quizCount;
        if (total <= 0) return false;
        return _uniqueLen(attempted.missing) >= vocabCount && _uniqueLen(attempted.quiz) >= quizCount;
    }
    return false;
}

function renderCurrentTopicSectionScores() {
    const badgeSpeaking = document.getElementById('badge-speaking');
    const badgeWriting = document.getElementById('badge-writing');
    const badgeTest = document.getElementById('badge-test');
    const elSpeaking = document.getElementById('score-speaking');
    const elWriting = document.getElementById('score-writing');
    const elTest = document.getElementById('score-test');
    if (!badgeSpeaking && !badgeWriting && !badgeTest && !elSpeaking && !elWriting && !elTest) return;

    if (!currentGradeId || !currentTopicId || !currentData) {
        if (badgeSpeaking) badgeSpeaking.classList.add('hidden');
        if (badgeWriting) badgeWriting.classList.add('hidden');
        if (badgeTest) badgeTest.classList.add('hidden');
        return;
    }

    const state = loadScoreState();
    const topic = ensureTopicProgress(state, currentGradeId, currentTopicId);

    const completeSpeaking = isSectionComplete(topic, currentData, 'speaking');
    const completeWriting = isSectionComplete(topic, currentData, 'writing');
    // Keep test score revealed only on Submit.
    const completeTest = false;

    if (badgeSpeaking) badgeSpeaking.classList.toggle('hidden', !completeSpeaking);
    if (badgeWriting) badgeWriting.classList.toggle('hidden', !completeWriting);
    if (badgeTest) badgeTest.classList.toggle('hidden', !completeTest);

    if (completeSpeaking && elSpeaking) {
        elSpeaking.innerText = String(getTopicSectionScore(currentGradeId, currentTopicId, 'speaking'));
    }
    if (completeWriting && elWriting) {
        elWriting.innerText = String(getTopicSectionScore(currentGradeId, currentTopicId, 'writing'));
    }
    if (completeTest && elTest) {
        elTest.innerText = String(getTopicSectionScore(currentGradeId, currentTopicId, 'test'));
    }
}

function announceSectionCompletedIfNeeded(section) {
    if (!currentGradeId || !currentTopicId || !currentData) return;

    const state = loadScoreState();
    const topic = ensureTopicProgress(state, currentGradeId, currentTopicId);
    if (!isSectionComplete(topic, currentData, section)) return;

    if (section === 'speaking') {
        const score = getTopicSectionScore(currentGradeId, currentTopicId, 'speaking');
        const status = document.getElementById('speak-status');
        if (status) {
            status.innerText = `Hoàn thành luyện nói! Điểm: ${score}/25`;
            status.className = 'text-lg font-bold text-green-600';
        }
        return;
    }

    if (section === 'writing') {
        const score = getTopicSectionScore(currentGradeId, currentTopicId, 'writing');
        const fb = document.getElementById('write-feedback');
        if (fb) {
            fb.innerText = `Hoàn thành luyện viết! Điểm: ${score}/25`;
            fb.className = 'mt-4 font-bold text-xl text-green-600';
        }

        // After finishing all writing items, allow redo for practice.
        setWritingRedoButton(true);
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
    const section = getScoreSectionForCategory(category);
    if (section) {
        const maxScore = getSectionMaxScore(section);
        const currentVal = typeof topic.sectionScores[section] === 'number' ? topic.sectionScores[section] : 0;
        topic.sectionScores[section] = clampScore(currentVal + delta, maxScore);
    }

    topic.score = clampScore(
        (topic.sectionScores?.speaking || 0) + (topic.sectionScores?.writing || 0) + (topic.sectionScores?.test || 0),
        TOPIC_MAX_SCORE
    );
    saveScoreState(state);
    renderTotalScore();
    renderCurrentTopicSectionScores();
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

    // Recompute/migrate score state for this topic based on completed items
    try {
        const state = loadScoreState();
        const topic = ensureTopicProgress(state, currentGradeId, currentTopicId);
        recomputeTopicScores(topic, currentData);
        saveScoreState(state);
    } catch { /* ignore */ }

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
    renderCurrentTopicSectionScores();
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

    // Nếu đã làm rồi (đúng hoặc sai) thì KHÔNG cho làm lại
    const micBtn = document.getElementById('mic-btn');
    const attempted = isAttemptedItem('speaking', currentIndex);
    setButtonLocked(micBtn, attempted);
    if (attempted) {
        document.getElementById('speak-status').innerText = 'Câu này đã làm rồi. Không thể làm lại.';
        document.getElementById('speak-status').className = 'text-lg font-bold text-slate-600 bg-slate-100 px-4 py-2 rounded-lg';
    }

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
    if (isAttemptedItem('speaking', currentIndex)) {
        alert('Câu này đã làm rồi. Không thể làm lại.');
        return;
    }
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

        // Count as attempted even if incorrect
        markAttemptedOnce('speaking', currentIndex);
        
        document.getElementById('speak-status').innerHTML = result.message;
        document.getElementById('speak-status').className = result.is_correct ? "text-lg font-bold text-green-600" : "text-lg font-bold text-red-500";
        
        // Hiển thị gợi ý sửa lỗi
        if (result.suggestion) {
            const suggBox = document.getElementById('speak-suggestion');
            suggBox.classList.remove('hidden');
            suggBox.innerHTML = `<b>💡 Gợi ý:</b> ${result.suggestion}`;
        }

        // Lock ngay sau lần làm đầu tiên (đúng hoặc sai)
        setButtonLocked(btn, true);

        if(result.is_correct) {
            awardTopicPointsOnce('speaking', currentIndex);
            playTTS("Excellent!");
            setTimeout(nextSpeak, 2000);
        }
        else { playTTS("Try again!"); }
        
        btn.classList.remove('animate-pulse', 'bg-red-500');
    };
}
function nextSpeak() {
    if (!currentData?.vocab || currentData.vocab.length <= 0) return;

    if (currentIndex < currentData.vocab.length - 1) {
        currentIndex++;
        updateSpeakCard();
        return;
    }

    // At the end: if the whole speaking section is complete, reveal score now.
    renderCurrentTopicSectionScores();
    announceSectionCompletedIfNeeded('speaking');
}
function prevSpeak() { if(currentIndex > 0) { currentIndex--; updateSpeakCard(); } }

// Writing Logic
function setWritingRedoButton(enabled) {
    const btn = document.getElementById('write-next-btn');
    if (!btn) return;

    const prevBtn = document.getElementById('write-prev-btn');
    if (prevBtn) prevBtn.classList.toggle('hidden', !!enabled);

    if (enabled) {
        btn.innerHTML = 'Làm lại phần viết <i class="fas fa-rotate-right"></i>';
        btn.onclick = resetWritingSection;
        btn.classList.remove('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
        btn.classList.add('bg-blue-600', 'text-white', 'hover:bg-blue-700');
    } else {
        const label = (writingMode === 'grammar')
            ? 'Câu tiếp theo <i class="fas fa-arrow-right"></i>'
            : 'Từ tiếp theo <i class="fas fa-arrow-right"></i>';
        btn.innerHTML = label;
        btn.onclick = nextWrite;
        btn.classList.remove('bg-blue-600', 'text-white', 'hover:bg-blue-700');
        btn.classList.add('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
    }
}

function resetWritingSection() {
    if (!currentGradeId || !currentTopicId || !currentData) return;

    // Only allow redo after the learner has attempted all items.
    try {
        const scoreState = loadScoreState();
        const topic = ensureTopicProgress(scoreState, currentGradeId, currentTopicId);
        if (!isSectionComplete(topic, currentData, 'writing')) {
            alert('Bé hãy làm xong hết các câu phần viết rồi mới làm lại nhé!');
            return;
        }
    } catch {}

    if (!confirm('Bé muốn làm lại phần viết từ đầu không? (Điểm sẽ không cộng thêm)')) return;

    // Clear writing drafts/results (attempt state)
    try {
        const attemptState = loadAttemptState();
        const topicAttempt = ensureTopicAttempt(attemptState, currentGradeId, currentTopicId);
        topicAttempt.writing = { vocab: {}, grammar: {} };
        saveAttemptState(attemptState);
    } catch {}

    // Unlock writing items by clearing attempted lists (score state)
    try {
        const scoreState = loadScoreState();
        const topic = ensureTopicProgress(scoreState, currentGradeId, currentTopicId);
        topic.attempted.writing = [];
        topic.attempted.grammar = [];
        saveScoreState(scoreState);
    } catch {}

    // Restart writing flow
    currentIndex = 0;
    grammarIndex = 0;
    writingMode = 'vocab';
    setWritingMode('vocab');
    setWritingRedoButton(false);
    updateWriteCard();
}

function updateWriteCard() {
    const suggestion = document.getElementById('write-suggestion');
    suggestion.classList.add('hidden');
    suggestion.innerHTML = '';
    document.getElementById('write-feedback').innerText = '';
    const writeInput = document.getElementById('write-input');

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

    // Restore draft + previous result for this exact item (unless user cleared it)
    try {
        const state = loadAttemptState();
        const topicAttempt = (currentGradeId && currentTopicId) ? ensureTopicAttempt(state, currentGradeId, currentTopicId) : null;
        const mode = (writingMode === 'grammar') ? 'grammar' : 'vocab';
        const itemId = (mode === 'grammar') ? grammarIndex : currentIndex;
        const item = topicAttempt ? getWritingItemAttempt(topicAttempt, mode, itemId) : null;
        if (writeInput) {
            writeInput.value = item?.value || '';
        }

        const fb = document.getElementById('write-feedback');
        if (fb && item?.result) {
            fb.innerText = item.result.message || '';
            fb.className = item.result.is_correct
                ? 'mt-4 font-bold text-xl text-green-600'
                : 'mt-4 font-bold text-xl text-red-500';
        }

        const sugg = document.getElementById('write-suggestion');
        if (sugg) {
            const s = item?.result?.suggestion;
            if (s) {
                sugg.classList.remove('hidden');
                sugg.innerHTML = `<b>💡 Gợi ý:</b> ${s}`;
            }
        }

        if (topicAttempt) saveAttemptState(state);
    } catch {}

    // Disable/enable based on whether this item was already attempted
    const writeSubmit = document.getElementById('write-submit-btn');
    const category = (writingMode === 'grammar') ? 'grammar' : 'writing';
    const itemId = (writingMode === 'grammar') ? grammarIndex : currentIndex;
    const attempted = isAttemptedItem(category, itemId);
    if (writeInput) {
        writeInput.disabled = attempted;
        writeInput.classList.toggle('opacity-50', attempted);
        writeInput.classList.toggle('cursor-not-allowed', attempted);
    }
    setButtonLocked(writeSubmit, attempted);

    if (!attempted) {
        document.getElementById('write-input').focus();
    }

    updateWriteNavButtons();

    // If finished all writing items, show redo button; otherwise keep next button.
    try {
        if (currentGradeId && currentTopicId && currentData) {
            const scoreState = loadScoreState();
            const topic = ensureTopicProgress(scoreState, currentGradeId, currentTopicId);
            setWritingRedoButton(isSectionComplete(topic, currentData, 'writing'));
        } else {
            setWritingRedoButton(false);
        }
    } catch {
        setWritingRedoButton(false);
    }
}

// Attach once per page
function setupWriting() {
    initWritingDraftPersistence();
    updateWriteCard();
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
    setWritingRedoButton(false);
}
async function checkWriting(options = {}) {
    const { silent = false } = (options && typeof options === 'object') ? options : {};
    const category = (writingMode === 'grammar') ? 'grammar' : 'writing';
    const itemId = (writingMode === 'grammar') ? grammarIndex : currentIndex;
    if (isAttemptedItem(category, itemId)) {
        if (!silent) alert('Câu này đã làm rồi. Không thể làm lại.');
        return;
    }

    const input = document.getElementById('write-input').value;
    persistCurrentWritingDraft(input);
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

    // Persist result so user can see old work later (unless they redo/reset)
    persistCurrentWritingResult(result);

    // Count as attempted even if incorrect
    if (payload?.context?.category && Number.isFinite(payload?.context?.itemId)) {
        markAttemptedOnce(payload.context.category, payload.context.itemId);
    }
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

    // Lock after first attempt (đúng hoặc sai)
    const writeInput = document.getElementById('write-input');
    const writeSubmit = document.getElementById('write-submit-btn');
    if (writeInput) {
        writeInput.disabled = true;
        writeInput.classList.add('opacity-50', 'cursor-not-allowed');
    }
    setButtonLocked(writeSubmit, true);
}

async function maybeAutoSubmitWriting() {
    try {
        const category = (writingMode === 'grammar') ? 'grammar' : 'writing';
        const itemId = (writingMode === 'grammar') ? grammarIndex : currentIndex;
        if (isAttemptedItem(category, itemId)) return false;

        const inputEl = document.getElementById('write-input');
        const val = String(inputEl?.value ?? '').trim();
        if (!val) return false;

        await checkWriting({ silent: true });
        return true;
    } catch {
        return false;
    }
}

function updateWriteNavButtons() {
    const prevBtn = document.getElementById('write-prev-btn');
    if (!prevBtn) return;

    if (!currentData) {
        prevBtn.disabled = true;
        prevBtn.classList.add('opacity-50', 'cursor-not-allowed');
        return;
    }

    let atStart = false;
    if (writingMode === 'grammar') {
        atStart = grammarIndex <= 0;
    } else {
        atStart = currentIndex <= 0;
    }

    prevBtn.disabled = atStart;
    prevBtn.classList.toggle('opacity-50', atStart);
    prevBtn.classList.toggle('cursor-not-allowed', atStart);
}

async function prevWrite() {
    // If user typed but forgot to submit, auto-submit before navigating.
    await maybeAutoSubmitWriting();

    if (writingMode === 'grammar') {
        if (grammarIndex > 0) {
            grammarIndex--;
            updateWriteCard();
        }
        return;
    }

    if (currentIndex > 0) {
        currentIndex--;
        updateWriteCard();
    }
}

async function nextWrite() {
    // If user typed but forgot to submit, auto-submit before navigating.
    await maybeAutoSubmitWriting();

    if (writingMode === 'grammar') {
        const hasGrammar = Array.isArray(currentData?.grammar) && currentData.grammar.length > 0;
        if (!hasGrammar) return;
        if (grammarIndex < currentData.grammar.length - 1) {
            grammarIndex++;
            updateWriteCard();
        } else {
            // End of grammar writing: show score only if writing section is fully complete.
            renderCurrentTopicSectionScores();
            if (currentGradeId && currentTopicId) {
                const state = loadScoreState();
                const topic = ensureTopicProgress(state, currentGradeId, currentTopicId);
                if (isSectionComplete(topic, currentData, 'writing')) {
                    announceSectionCompletedIfNeeded('writing');
                } else {
                    alert("Bạn đã tới cuối phần viết câu. Hãy làm đúng tất cả bài để nhận điểm.");
                }
            } else {
                alert("Hết bài viết câu!");
            }
        }
        return;
    }

    if(currentIndex < currentData.vocab.length-1) {
        currentIndex++;
        updateWriteCard();
    } else {
        // End of vocab writing: show score if writing section is fully complete (or prompt to finish grammar).
        renderCurrentTopicSectionScores();
        if (currentGradeId && currentTopicId) {
            const state = loadScoreState();
            const topic = ensureTopicProgress(state, currentGradeId, currentTopicId);
            if (isSectionComplete(topic, currentData, 'writing')) {
                announceSectionCompletedIfNeeded('writing');
            } else {
                const hasGrammar = Array.isArray(currentData?.grammar) && currentData.grammar.length > 0;
                if (hasGrammar) {
                    // Auto-switch to Grammar writing
                    grammarIndex = 0;
                    setWritingMode('grammar');
                    const fb = document.getElementById('write-feedback');
                    if (fb) {
                        fb.innerText = "Đã chuyển sang phần Viết câu. Làm xong để nhận điểm nhé!";
                        fb.className = "mt-4 font-bold text-xl text-slate-600";
                    }
                } else {
                    alert("Bạn đã tới cuối bài. Hãy làm đúng tất cả để nhận điểm.");
                }
            }
        } else {
            alert("Hết bài!");
        }
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

    // Review toolbar (shown only when user clicks "Xem lại bài")
    html += `
        <div id="quiz-review-toolbar" class="hidden mb-4 p-3 rounded-xl bg-yellow-50 border border-yellow-200 text-yellow-900 font-bold flex items-center justify-between gap-3">
            <div><i class="fas fa-eye mr-2"></i>Đang xem lại bài vừa làm</div>
            <button type="button" onclick="backToQuizResult()" class="px-3 py-2 rounded-lg bg-white border border-yellow-200 hover:bg-yellow-100">Quay lại kết quả</button>
        </div>
    `;

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

    // --- Điền chữ (gõ trực tiếp vào chữ bị thiếu) ---
    if (hasVocab) {
        html += `
            <div class="p-4 border border-slate-200 rounded-xl bg-white">
                <div class="space-y-4">
                    ${currentData.vocab.map((w, idx) => `
                        <div class="p-4 border border-slate-200 rounded-xl bg-slate-50">
                            <div class="text-sm text-slate-600 font-bold mb-2">${w.vi}</div>
                            <div class="flex items-center justify-between gap-3 flex-wrap">
                                <div id="ml-word-${idx}" class="text-2xl font-black text-slate-800 tracking-wider"></div>
                            </div>
                            <div id="ml-feedback-${idx}" class="mt-2 text-sm font-bold"></div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    html += `<button id="quiz-submit-btn" onclick="finishQuiz()" class="w-full py-3 bg-blue-600 text-white font-bold rounded-xl mt-4">Nộp Bài</button>`;
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

    // Restore previous attempt UI for this topic (unless user clicked "Làm lại bài")
    hydrateTestAttemptUI({ suppressAutoResultView: false, revealAnswers: false });
}

function hydrateTestAttemptUI({ suppressAutoResultView = false, revealAnswers = false } = {}) {
    if (!currentGradeId || !currentTopicId || !currentData) return;
    const state = loadAttemptState();
    const topicAttempt = ensureTopicAttempt(state, currentGradeId, currentTopicId);

    // Hydrate quiz selections
    try {
        const quizState = topicAttempt?.test?.quiz || {};
        for (const [qIdxRaw, rec] of Object.entries(quizState)) {
            const qIdx = Number(qIdxRaw);
            if (!Number.isFinite(qIdx)) continue;
            const optIdx = Number(rec?.selectedOptIdx);
            if (!Number.isFinite(optIdx)) continue;

            const btn = document.querySelector(`button[data-quiz-q="${qIdx}"][data-quiz-opt="${optIdx}"]`);
            if (!btn || !btn.parentElement) continue;

            // Always restore the selection, but do not grade until Submit.
            btn.classList.add('bg-blue-100', 'border-blue-500');

            if (revealAnswers) {
                const q = currentData?.quiz?.[qIdx];
                const correctAns = String(q?.answer ?? '').trim();
                const siblings = btn.parentElement.children;
                for (let sib of siblings) {
                    sib.disabled = true;
                    if (correctAns && sib.innerText.trim() === correctAns) {
                        sib.classList.add('bg-green-100', 'border-green-500');
                    }
                }

                const isCorrect = !!rec?.is_correct;
                if (isCorrect) {
                    btn.classList.remove('bg-blue-100', 'border-blue-500');
                    btn.classList.add('bg-green-100', 'border-green-500');
                } else {
                    btn.classList.remove('bg-blue-100', 'border-blue-500');
                    btn.classList.add('bg-red-100', 'border-red-500');
                }
            }
        }
    } catch {}

    // Hydrate missing letters inputs
    try {
        const missingState = topicAttempt?.test?.missing || {};
        for (const [wIdxRaw, rec] of Object.entries(missingState)) {
            const wIdx = Number(wIdxRaw);
            if (!Number.isFinite(wIdx)) continue;
            const mount = document.getElementById(`ml-word-${wIdx}`);
            if (!mount) continue;
            const inputs = Array.from(mount.querySelectorAll('input[data-ml-idx]'));
            const letters = rec?.letters && typeof rec.letters === 'object' ? rec.letters : {};
            for (const inp of inputs) {
                const pos = String(inp.getAttribute('data-ml-pos') || '');
                if (pos && Object.prototype.hasOwnProperty.call(letters, pos)) {
                    inp.value = String(letters[pos] ?? '');
                }
            }

            const feedbackEl = document.getElementById(`ml-feedback-${wIdx}`);
            if (feedbackEl) {
                if (revealAnswers && topicAttempt?.test?.finished) {
                    const correctWord = String(currentData?.vocab?.[wIdx]?.en ?? '').trim();
                    if (rec?.is_correct) {
                        feedbackEl.innerHTML = 'Đúng rồi! 🎉';
                        feedbackEl.className = 'mt-2 text-sm font-bold text-green-600';
                    } else {
                        feedbackEl.innerHTML = correctWord ? `Sai rồi. Đáp án đúng: <b>${escapeHtml(correctWord)}</b>` : 'Sai rồi.';
                        feedbackEl.className = 'mt-2 text-sm font-bold text-red-500';
                    }
                } else {
                    // While doing (not submitted), do not show grading.
                    feedbackEl.innerHTML = '';
                    feedbackEl.className = 'mt-2 text-sm font-bold';
                }
            }

            // Only lock inputs during review after submit
            for (const inp of inputs) inp.disabled = !!(revealAnswers && topicAttempt?.test?.finished);
        }
    } catch {}

    // If user previously submitted, keep result view visible
    try {
        if (!suppressAutoResultView && topicAttempt?.test?.finished) {
            showQuizResultView(false);
        }
    } catch {}

    saveAttemptState(state);
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
                selectQuizOption(quizBtn, qIdx, optIdx);
            }
            return;
        }
    });

    container.dataset.handlersAttached = '1';
}

function isCurrentTopicTestSubmitted() {
    try {
        if (!currentGradeId || !currentTopicId) return false;
        const state = loadAttemptState();
        const topicAttempt = ensureTopicAttempt(state, currentGradeId, currentTopicId);
        return !!topicAttempt?.test?.finished;
    } catch {
        return false;
    }
}

function persistQuizSelection(questionIndex, optIdx) {
    try {
        if (!currentGradeId || !currentTopicId) return;
        const state = loadAttemptState();
        const topicAttempt = ensureTopicAttempt(state, currentGradeId, currentTopicId);
        const key = String(questionIndex);
        if (!topicAttempt.test.quiz[key] || typeof topicAttempt.test.quiz[key] !== 'object') {
            topicAttempt.test.quiz[key] = {};
        }
        topicAttempt.test.quiz[key].selectedOptIdx = Number(optIdx);
        saveAttemptState(state);
    } catch {}
}

function selectQuizOption(btn, questionIndex, optIdx) {
    if (!btn || !btn.parentElement) return;
    if (isCurrentTopicTestSubmitted()) return;

    // Clear previous UI selection for this question
    const siblings = btn.parentElement.children;
    for (let sib of siblings) {
        sib.classList.remove('bg-blue-100', 'border-blue-500', 'bg-green-100', 'border-green-500', 'bg-red-100', 'border-red-500');
    }

    // Mark selected
    btn.classList.add('bg-blue-100', 'border-blue-500');
    persistQuizSelection(questionIndex, optIdx);
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

    // Persist draft letter
    try {
        if (!currentGradeId || !currentTopicId) return;
        const state = loadAttemptState();
        const topicAttempt = ensureTopicAttempt(state, currentGradeId, currentTopicId);
        const wordIndex = String(idx);
        if (!topicAttempt.test.missing[wordIndex] || typeof topicAttempt.test.missing[wordIndex] !== 'object') {
            topicAttempt.test.missing[wordIndex] = { letters: {}, is_correct: false, feedback: '' };
        }
        if (!topicAttempt.test.missing[wordIndex].letters || typeof topicAttempt.test.missing[wordIndex].letters !== 'object') {
            topicAttempt.test.missing[wordIndex].letters = {};
        }
        topicAttempt.test.missing[wordIndex].letters[String(pos)] = String(input.value || '');
        saveAttemptState(state);
    } catch {}
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
        // Count as attempted even if incorrect
        markAttemptedOnce('missing', wordIndex);
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

        // Lock after first attempt (đúng hoặc sai)
        for (const inp of inputs) inp.disabled = true;
        const lockBtn = document.getElementById(`ml-btn-${wordIndex}`);
        if (lockBtn) lockBtn.disabled = true;

        if (result.is_correct) {
            if (!result.already_correct) {
                awardTopicPointsOnce('missing', wordIndex);
            }
            playTTS(original);
        }

        // Persist result + locked state
        try {
            if (currentGradeId && currentTopicId) {
                const state = loadAttemptState();
                const topicAttempt = ensureTopicAttempt(state, currentGradeId, currentTopicId);
                const recKey = String(wordIndex);
                if (!topicAttempt.test.missing[recKey] || typeof topicAttempt.test.missing[recKey] !== 'object') {
                    topicAttempt.test.missing[recKey] = { letters: {}, is_correct: false, feedback: '' };
                }
                topicAttempt.test.missing[recKey].is_correct = !!result.is_correct;
                topicAttempt.test.missing[recKey].feedback = String(result.message || (result.is_correct ? 'Đúng rồi! 🎉' : 'Chưa đúng, thử lại nhé!'));

                // Also persist current letters from DOM
                const letters = {};
                for (const inp of inputs) {
                    const pos = String(inp.getAttribute('data-ml-pos') || '');
                    if (!pos) continue;
                    letters[pos] = String(inp.value || '');
                }
                topicAttempt.test.missing[recKey].letters = letters;
                saveAttemptState(state);
            }
        } catch {}
    } catch {
        // Count as attempted even if incorrect
        markAttemptedOnce('missing', wordIndex);
        // Fallback khi lỗi mạng: vẫn chấm local
        const ok = answer.toLowerCase() === original.toLowerCase();
        feedbackEl.innerText = ok ? 'Đúng rồi! 🎉' : 'Chưa đúng, thử lại nhé!';
        feedbackEl.className = ok
            ? 'mt-2 text-sm font-bold text-green-600'
            : 'mt-2 text-sm font-bold text-red-500';
        // Lock after first attempt (đúng hoặc sai)
        for (const inp of inputs) inp.disabled = true;
        const lockBtn = document.getElementById(`ml-btn-${wordIndex}`);
        if (lockBtn) lockBtn.disabled = true;

        if (ok) {
            awardTopicPointsOnce('missing', wordIndex);
            playTTS(original);
        }

        // Persist fallback result
        try {
            if (currentGradeId && currentTopicId) {
                const state = loadAttemptState();
                const topicAttempt = ensureTopicAttempt(state, currentGradeId, currentTopicId);
                const recKey = String(wordIndex);
                if (!topicAttempt.test.missing[recKey] || typeof topicAttempt.test.missing[recKey] !== 'object') {
                    topicAttempt.test.missing[recKey] = { letters: {}, is_correct: false, feedback: '' };
                }
                topicAttempt.test.missing[recKey].is_correct = !!ok;
                topicAttempt.test.missing[recKey].feedback = ok ? 'Đúng rồi! 🎉' : 'Chưa đúng, thử lại nhé!';

                const letters = {};
                for (const inp of inputs) {
                    const pos = String(inp.getAttribute('data-ml-pos') || '');
                    if (!pos) continue;
                    letters[pos] = String(inp.value || '');
                }
                topicAttempt.test.missing[recKey].letters = letters;
                saveAttemptState(state);
            }
        } catch {}
    }
}

function gradeCurrentTopicTest() {
    if (!currentGradeId || !currentTopicId || !currentData) return;
    const hasQuiz = Array.isArray(currentData?.quiz) && currentData.quiz.length > 0;
    const hasVocab = Array.isArray(currentData?.vocab) && currentData.vocab.length > 0;

    // Evaluate and persist into attempt-state
    const attemptState = loadAttemptState();
    const topicAttempt = ensureTopicAttempt(attemptState, currentGradeId, currentTopicId);

    if (hasQuiz) {
        for (let qIdx = 0; qIdx < currentData.quiz.length; qIdx++) {
            const q = currentData.quiz[qIdx];
            const correctAns = String(q?.answer ?? '').trim();
            const opts = Array.isArray(q?.options) ? q.options : [];
            const key = String(qIdx);
            const selectedOptIdx = Number(topicAttempt?.test?.quiz?.[key]?.selectedOptIdx);
            const selectedText = Number.isFinite(selectedOptIdx) ? String(opts[selectedOptIdx] ?? '').trim() : '';

            const isCorrect = !!selectedText && !!correctAns && selectedText === correctAns;
            if (!topicAttempt.test.quiz[key] || typeof topicAttempt.test.quiz[key] !== 'object') {
                topicAttempt.test.quiz[key] = {};
            }
            topicAttempt.test.quiz[key].selectedOptIdx = Number.isFinite(selectedOptIdx) ? selectedOptIdx : null;
            topicAttempt.test.quiz[key].is_correct = !!isCorrect;

            // Mark attempted only when submitting
            markAttemptedOnce('quiz', qIdx);
            if (isCorrect) awardTopicPointsOnce('quiz', qIdx);
        }
    }

    if (hasVocab) {
        for (let wIdx = 0; wIdx < currentData.vocab.length; wIdx++) {
            const correctWord = String(currentData?.vocab?.[wIdx]?.en ?? '').trim();
            const mount = document.getElementById(`ml-word-${wIdx}`);
            const feedbackEl = document.getElementById(`ml-feedback-${wIdx}`);
            if (!mount) continue;
            const inputs = Array.from(mount.querySelectorAll('input[data-ml-idx]'));

            // Snapshot current letters
            const letters = {};
            for (const inp of inputs) {
                const pos = String(inp.getAttribute('data-ml-pos') || '');
                if (!pos) continue;
                letters[pos] = String(inp.value || '');
            }

            // Reconstruct answer
            const chars = Array.from(String(correctWord || ''));
            const byPos = new Map();
            for (const inp of inputs) {
                const pos = Number(inp.getAttribute('data-ml-pos'));
                byPos.set(pos, String(inp.value || '').trim());
            }
            let answer = '';
            for (let i = 0; i < chars.length; i++) {
                if (byPos.has(i)) answer += byPos.get(i) || '';
                else answer += chars[i];
            }

            const isCorrect = !!correctWord && answer.toLowerCase() === correctWord.toLowerCase();
            const key = String(wIdx);
            if (!topicAttempt.test.missing[key] || typeof topicAttempt.test.missing[key] !== 'object') {
                topicAttempt.test.missing[key] = { letters: {}, is_correct: false, feedback: '' };
            }
            topicAttempt.test.missing[key].letters = letters;
            topicAttempt.test.missing[key].is_correct = !!isCorrect;
            topicAttempt.test.missing[key].feedback = '';

            if (feedbackEl) {
                feedbackEl.innerHTML = '';
                feedbackEl.className = 'mt-2 text-sm font-bold';
            }

            // Mark attempted only when submitting
            markAttemptedOnce('missing', wIdx);
            if (isCorrect) awardTopicPointsOnce('missing', wIdx);
        }
    }

    saveAttemptState(attemptState);
}
function showQuizResultView(playSound = false) {
    document.getElementById('quiz-container').classList.add('hidden');
    document.getElementById('quiz-result').classList.remove('hidden');

    const toolbar = document.getElementById('quiz-review-toolbar');
    if (toolbar) toolbar.classList.add('hidden');
    const testScore = (currentGradeId && currentTopicId)
        ? getTopicSectionScore(currentGradeId, currentTopicId, 'test')
        : 0;
    document.getElementById('quiz-score-display').innerText = String(testScore);

    const badgeTest = document.getElementById('badge-test');
    const elTest = document.getElementById('score-test');
    if (badgeTest) badgeTest.classList.remove('hidden');
    if (elTest) elTest.innerText = String(testScore);

    if (playSound) playTTS('Good job!');
}

function viewQuizReview() {
    const container = document.getElementById('quiz-container');
    const result = document.getElementById('quiz-result');
    if (!container || !result) return;

    result.classList.add('hidden');
    container.classList.remove('hidden');

    const submitBtn = document.getElementById('quiz-submit-btn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add('opacity-50', 'cursor-not-allowed');
        submitBtn.textContent = 'Đã nộp bài';
    }

    const toolbar = document.getElementById('quiz-review-toolbar');
    if (toolbar) toolbar.classList.remove('hidden');

    // Re-apply attempt UI and reveal correct answers (after submit)
    hydrateTestAttemptUI({ suppressAutoResultView: true, revealAnswers: true });
}

function backToQuizResult() {
    showQuizResultView(false);
}

function finishQuiz() {
    if (isCurrentTopicTestSubmitted()) {
        showQuizResultView(false);
        return;
    }

    // Grade ONLY when submitting
    gradeCurrentTopicTest();

    // Mark finished so next time user sees old attempt unless they click reset
    try {
        if (currentGradeId && currentTopicId) {
            const state = loadAttemptState();
            const topicAttempt = ensureTopicAttempt(state, currentGradeId, currentTopicId);
            topicAttempt.test.finished = true;
            saveAttemptState(state);
        }
    } catch {}

    showQuizResultView(true);
}

function resetQuiz() {
    clearCurrentTopicTestAttempt();
    renderQuiz();
}

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
        const botDiv = appendMsg(data.reply, 'bg-white text-slate-700 self-start border border-slate-200');
        if (data && typeof data === 'object' && data.missing) {
            initChatEventDelegation();
            hydrateChatMissingUI(botDiv, data.missing);
        }
        renderChatActions(data.actions);
    } catch(e) { appendMsg("Lỗi mạng", 'bg-red-100 text-red-600'); }
}
function appendMsg(text, cls) {
    const div = document.createElement('div');
    div.className = `p-2 rounded-xl max-w-[85%] text-sm ${cls}`;
    div.innerHTML = text;
    document.getElementById('chat-messages').appendChild(div);
    document.getElementById('chat-messages').scrollTop = 9999;
    return div;
}

let CHAT_MISSING_UID = 0;
const CHAT_MISSING_STATE = new Map();

function initChatEventDelegation() {
    const container = document.getElementById('chat-messages');
    if (!container || container.dataset.chatHandlersAttached === '1') return;

    container.addEventListener('click', async (e) => {
        const ttsBtn = e.target.closest('button[data-chat-ml-tts]');
        if (ttsBtn) {
            const id = String(ttsBtn.getAttribute('data-chat-ml-tts') || '').trim();
            const st = CHAT_MISSING_STATE.get(id);
            if (st && st.word) playTTS(st.word);
            return;
        }

        const checkBtn = e.target.closest('button[data-chat-ml-check]');
        if (checkBtn) {
            const id = String(checkBtn.getAttribute('data-chat-ml-check') || '').trim();
            if (!id) return;
            const card = checkBtn.closest('[data-chat-ml-card]');
            if (!card) return;
            await checkChatMissingLetters(card, id);
        }
    });

    container.dataset.chatHandlersAttached = '1';
}

function hydrateChatMissingUI(botMsgDiv, missing) {
    if (!botMsgDiv || !missing || typeof missing !== 'object') return;

    const word = String(missing.en || '').trim();
    const vi = String(missing.vi || '').trim();
    const vocabIndex = Number(missing.vocabIndex);
    if (!word) return;

    const mount = botMsgDiv.querySelector('[data-chat-missing-mount="1"]');
    if (!mount) return;

    const id = `chatml_${++CHAT_MISSING_UID}`;
    CHAT_MISSING_STATE.set(id, {
        word,
        vi,
        vocabIndex: Number.isFinite(vocabIndex) ? vocabIndex : null,
    });

    mount.innerHTML = `
        <div data-chat-ml-card="1" class="p-3 bg-slate-50 border border-slate-200 rounded-xl">
            <div class="text-sm text-slate-600 font-bold mb-2">${escapeHtml(vi)}</div>
            <div class="mb-3">${buildMissingLettersHtml(word, id)}</div>
            <div class="flex items-center gap-3 flex-wrap">
                <button type="button" data-chat-ml-check="${escapeHtml(id)}" class="px-4 py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700">Kiểm tra</button>
                <button type="button" data-chat-ml-tts="${escapeHtml(id)}" class="px-3 py-2 bg-white border border-slate-200 text-slate-700 font-bold rounded-lg hover:bg-slate-50">Nghe mẫu</button>
            </div>
            <div data-chat-ml-feedback="${escapeHtml(id)}" class="mt-2 text-sm font-bold"></div>
        </div>
    `;
}

async function checkChatMissingLetters(cardEl, id) {
    const st = CHAT_MISSING_STATE.get(id);
    if (!st) return;

    const feedbackEl = cardEl.querySelector(`[data-chat-ml-feedback="${id}"]`);
    const checkBtn = cardEl.querySelector(`button[data-chat-ml-check="${id}"]`);
    const inputs = Array.from(cardEl.querySelectorAll(`input[data-ml-idx="${id}"]`));
    if (!feedbackEl || inputs.length === 0) return;

    const original = String(st.word || '');
    const chars = Array.from(original);
    const byPos = new Map();
    for (const inp of inputs) {
        const pos = Number(inp.getAttribute('data-ml-pos'));
        byPos.set(pos, String(inp.value || '').trim());
    }

    let answer = '';
    for (let i = 0; i < chars.length; i++) {
        if (byPos.has(i)) answer += byPos.get(i) || '';
        else answer += chars[i];
    }

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
                    itemId: st.vocabIndex,
                },
            })
        });

        const result = await res.json();
        feedbackEl.innerHTML = result.message || (result.is_correct ? 'Đúng rồi! 🎉' : 'Chưa đúng, thử lại nhé!');
        feedbackEl.className = result.is_correct
            ? 'mt-2 text-sm font-bold text-green-600'
            : 'mt-2 text-sm font-bold text-red-500';

        if (result.is_correct) {
            if (!result.already_correct && Number.isFinite(st.vocabIndex)) {
                awardTopicPointsOnce('missing', st.vocabIndex);
            }
            for (const inp of inputs) inp.disabled = true;
            if (checkBtn) checkBtn.disabled = true;
            playTTS(original);
        }
    } catch {
        feedbackEl.textContent = 'Lỗi mạng';
        feedbackEl.className = 'mt-2 text-sm font-bold text-red-500';
    }
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
        case 'start_missing': return 'điền chữ';
        case 'start_quiz': return 'kiểm tra';
        case 'translate': return 'dịch';
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
        const botDiv = appendMsg(data.reply, 'bg-white text-slate-700 self-start border border-slate-200');
        if (data && typeof data === 'object' && data.missing) {
            initChatEventDelegation();
            hydrateChatMissingUI(botDiv, data.missing);
        }
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
        { action: 'translate', label: 'Dịch' },
        { action: 'start_missing', label: 'Điền chữ' },
        { action: 'start_quiz', label: 'Kiểm tra' },
    ]);
}

// Floating Chat Widget Logic
function toggleFloatingChat() {
    const win = document.getElementById('chat-widget-window');
    if (!win) return;
    win.classList.toggle('hidden-chat');
}

function sendWidgetChat() {
    const input = document.getElementById('chat-widget-input');
    if (!input) return;
    const msg = input.value.trim();
    if (!msg) return;
    renderWidgetMessage(msg, 'user');
    input.value = '';
    // Gửi yêu cầu dịch tới API chat
    fetch('/api/chat', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ message: 'dịch ' + msg })
    })
    .then(r => r.json())
    .then(data => {
        renderWidgetMessage(data.reply || 'Không có phản hồi', 'bot');
    })
    .catch(() => {
        renderWidgetMessage('Lỗi mạng', 'bot');
    });
}

function renderWidgetMessage(text, who) {
    const box = document.getElementById('chat-widget-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'p-3 rounded-2xl border text-sm shadow-sm mb-2 ' + (who === 'user' ? 'self-end bg-blue-100 border-blue-200 text-blue-800' : 'self-start bg-white border-slate-200 text-slate-700');
    div.innerHTML = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

// Chỉ hiển thị nút bong bóng chat dịch khi đang ở chế độ tự học (screen-learn). Ẩn khi chuyển sang chế độ khác.
function updateWidgetChatVisibility() {
    const btn = document.getElementById('chat-widget-btn');
    const win = document.getElementById('chat-widget-window');
    const learnScreen = document.getElementById('screen-learn');
    if (!btn || !win || !learnScreen) return;
    const isLearnVisible = !learnScreen.classList.contains('hidden');
    btn.style.display = isLearnVisible ? 'flex' : 'none';
    if (!isLearnVisible) win.classList.add('hidden-chat');
}

// Patch showScreen to update widget visibility
const _origShowScreen = window.showScreen;
window.showScreen = function(name) {
    if (typeof _origShowScreen === 'function') _origShowScreen(name);
    updateWidgetChatVisibility();
};
window.addEventListener('DOMContentLoaded', updateWidgetChatVisibility);