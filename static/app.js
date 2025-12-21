let currentData = null;
let currentIndex = 0;
let grammarIndex = 0;
let writingMode = 'vocab';
let currentGradeId = null;
let currentTopicId = null;

const SCORE_STORAGE_KEY = 'robo_english_scores_v1';
const TOPIC_MAX_SCORE = 100;

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = new SpeechRecognition ? new SpeechRecognition() : null;
if(recognition) { recognition.lang = 'en-US'; recognition.continuous = false; }

window.onload = loadCurriculum;

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
            },
        };
    }
    if (typeof state.topics[key].score !== 'number') state.topics[key].score = 0;
    if (!state.topics[key].completed || typeof state.topics[key].completed !== 'object') {
        state.topics[key].completed = { speaking: [], writing: [], grammar: [], quiz: [] };
    }
    for (const cat of ['speaking', 'writing', 'grammar', 'quiz']) {
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

    const totalItems = (vocabCount > 0 ? vocabCount : 0) * 2 + (grammarCount > 0 ? grammarCount : 0) + (quizCount > 0 ? quizCount : 0);
    if (totalItems <= 0) return;

    const doneCount =
        (Array.isArray(topicProgress.completed.speaking) ? topicProgress.completed.speaking.length : 0) +
        (Array.isArray(topicProgress.completed.writing) ? topicProgress.completed.writing.length : 0) +
        (Array.isArray(topicProgress.completed.grammar) ? topicProgress.completed.grammar.length : 0) +
        (Array.isArray(topicProgress.completed.quiz) ? topicProgress.completed.quiz.length : 0);

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
    showScreen('learn');
    currentIndex = 0;
    grammarIndex = 0;
    writingMode = 'vocab';
    renderVocab(); setupSpeaking(); setupWriting(); renderQuiz();
    switchTab('vocab');
}

function showScreen(name) {
    document.getElementById('screen-home').classList.toggle('hidden', name !== 'home');
    document.getElementById('screen-learn').classList.toggle('hidden', name !== 'learn');
    if (name === 'home') loadCurriculum();
}

// --- Render Functions ---
function renderVocab() {
    const container = document.getElementById('content-vocab');
    container.innerHTML = currentData.vocab.map(word => `<div onclick="playTTS('${word.en}')" class="bg-slate-50 hover:bg-white border-2 border-transparent hover:border-blue-400 cursor-pointer rounded-2xl p-4 flex flex-col items-center text-center transition shadow-sm group"><div class="text-5xl mb-3 transform group-hover:scale-110 transition">${word.img}</div><div class="font-bold text-lg text-slate-800">${word.en}</div><div class="text-sm text-slate-500">${word.vi}</div></div>`).join('');
}

// Speaking Logic
function setupSpeaking() { updateSpeakCard(); }
function updateSpeakCard() {
    const word = currentData.vocab[currentIndex];
    document.getElementById('speak-img').innerText = word.img;
    document.getElementById('speak-word').innerText = word.en;
    document.getElementById('speak-meaning').innerText = word.vi;
    document.getElementById('speak-status').innerText = "Bấm micro để đọc";
    document.getElementById('speak-status').className = "text-lg font-bold text-slate-500 bg-slate-100 px-4 py-2 rounded-lg";
    document.getElementById('speak-suggestion').classList.add('hidden'); // Ẩn gợi ý cũ
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
            body: JSON.stringify({ mode: 'speaking', user_answer: userSaid, correct_answer: correctWord })
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
    const payload = { mode: 'writing', user_answer: input, correct_answer: '' };

    if (writingMode === 'grammar') {
        const hasGrammar = Array.isArray(currentData?.grammar) && currentData.grammar.length > 0;
        if (!hasGrammar) return;
        payload.mode = 'grammar';
        payload.correct_answer = currentData.grammar[grammarIndex].answer;
    } else {
        payload.correct_answer = currentData.vocab[currentIndex].en;
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
    if(!Array.isArray(currentData.quiz) || currentData.quiz.length === 0) { container.innerHTML = "Chưa có quiz"; return; }
    let html = currentData.quiz.map((q, idx) => `
        <div class="p-4 border border-slate-200 rounded-xl bg-slate-50">
            <p class="font-bold mb-3">Câu ${idx+1}: ${q.question}</p>
            <div class="grid grid-cols-1 gap-2">
                ${q.options.map(opt => `<button onclick="checkQuiz(this, ${idx}, '${opt}', '${q.answer}')" class="quiz-opt-btn w-full text-left px-4 py-2 bg-white rounded-lg border hover:border-blue-400">${opt}</button>`).join('')}
            </div>
        </div>`).join('');
    html += `<button onclick="finishQuiz()" class="w-full py-3 bg-blue-600 text-white font-bold rounded-xl mt-4">Nộp Bài</button>`;
    container.innerHTML = html;
    document.getElementById('quiz-result').classList.add('hidden');
    container.classList.remove('hidden');
}
async function checkQuiz(btn, questionIndex, userChoice, correctAns) {
    const res = await fetch('/api/check', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ mode: 'quiz', user_answer: userChoice, correct_answer: correctAns }) });
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
    const win = document.getElementById('chat-window'); win.classList.toggle('hidden-chat'); 
    if(!win.classList.contains('hidden-chat')) document.getElementById('chat-input').focus(); 
}
async function sendChat() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if(!msg) return;
    appendMsg(msg, 'bg-blue-600 text-white self-end');
    input.value = '';
    try {
        const res = await fetch('/api/chat', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ message: msg }) });
        const data = await res.json();
        appendMsg(data.reply, 'bg-white text-slate-700 self-start border border-slate-200');
        if(data.reply.includes("🇬🇧")) {
                const englishText = data.reply.split("<b>")[1].split("</b>")[0];
                playTTS(englishText);
        }
    } catch(e) { appendMsg("Lỗi mạng", 'bg-red-100 text-red-600'); }
}
function appendMsg(text, cls) {
    const div = document.createElement('div');
    div.className = `p-2 rounded-xl max-w-[85%] text-sm ${cls}`;
    div.innerHTML = text;
    document.getElementById('chat-messages').appendChild(div);
    document.getElementById('chat-messages').scrollTop = 9999;
}