/* ============================================================
   try.js — Completed single-file version (Rule-based chatbot)
   - Scheduler: meal breaks, short breaks, timeline, export/share, notifications, persistence
   - Voice input + TTS
   - Rule-based chatbot that answers many questions locally (no API)
   - Saves to localStorage, includes daily reminders
   ============================================================ */

"use strict";

/* -------------------------
   State & DOM refs
--------------------------*/
let recognition = null;
let micPermissionGranted = false;
let tasks = []; // main schedule array: { task, start, end, done, meta }
const STORAGE_KEY = "ai_schedule_v1";

/* DOM helper */
const $ = id => document.getElementById(id);

/* Core elements */
const taskInput = $("taskInput");
const startInput = $("startTime");
const endInput = $("endTime");
const dateInput = $("taskDate");
const outputBox = $("outputBox");
const suggestionBox = $("suggestionBox");
const progressFill = $("progressFill");
const dingSound = $("dingSound");

const mealToggle = $("mealToggle");
const shortToggle = $("shortToggle");

const generateBtn = $("generateBtn");
const resetBtn = $("resetBtn");

/* Add-ons */
const exportBtn = $("exportPDF");
const shareBtn = $("shareLink");
const gcalBtn = $("syncGoogleCal");
const dailyBtn = $("dailyNotify");

/* Optional elements */
const timelineBox = $("timelineBox");
const prodEl = $("productivityScore");
const compEl = $("prodCompleted");
const aiEl = $("aiScore");
const categorySelect = $("category");

/* Chat elements */
const chatBtn = $("chatbot-btn");
const chatBox = $("chatbot-box");
const closeChatbot = $("closeChatbot");
const sendBtn = $("sendBtn");
const userInput = $("userInput");
const chatMessages = $("chatMessages");

/* default today's date */
if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);

/* -------------------------
   Small helpers
--------------------------*/
function safe(fn) { try { fn(); } catch (e) { console.error(e); } }

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (m) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m]));
}

// Accepts "HH:MM", "H:MM", optionally "HH:MM:SS". Returns minutes since midnight or NaN
function parseTime(value) {
  if (value === undefined || value === null || value === "") return NaN;
  value = String(value).trim();
  const m1 = value.match(/^(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*(am|pm))?$/i);
  if (m1) {
    let hh = parseInt(m1[1], 10);
    const mm = parseInt(m1[2], 10);
    const ampm = m1[3] ? m1[3].toLowerCase() : null;
    if (ampm) {
      if (ampm === "pm" && hh < 12) hh += 12;
      if (ampm === "am" && hh === 12) hh = 0;
    }
    return hh * 60 + mm;
  }
  const d = new Date(value);
  if (!isNaN(d.getTime())) return d.getHours() * 60 + d.getMinutes();
  return NaN;
}

function formatMin(mins) {
  mins = Math.round(mins);
  mins = mins % (24 * 60);
  if (mins < 0) mins = 0;
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

function hhmmToMin(hhmm) {
  if (!hhmm) return NaN;
  const parts = String(hhmm).split(":").map(Number);
  if (parts.length < 2) return NaN;
  const [h, m] = parts;
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

/* debounce helper */
function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/* -------------------------
   Persistence (LocalStorage)
--------------------------*/
function saveState() {
  try {
    const payload = {
      tasks,
      date: dateInput ? dateInput.value : new Date().toISOString().slice(0,10),
      settings: {
        mealToggle: !!(mealToggle && mealToggle.checked),
        shortToggle: !!(shortToggle && shortToggle.checked),
        category: categorySelect ? categorySelect.value : null
      }
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("Could not save state:", e);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const payload = JSON.parse(raw);
    if (payload && Array.isArray(payload.tasks)) {
      tasks = payload.tasks.map(t => Object.assign({ done: !!t.done, meta: t.meta || {} }, t));
      if (dateInput && payload.date) dateInput.value = payload.date;
      if (mealToggle && payload.settings) mealToggle.checked = !!payload.settings.mealToggle;
      if (shortToggle && payload.settings) shortToggle.checked = !!payload.settings.shortToggle;
      if (categorySelect && payload.settings) categorySelect.value = payload.settings.category || categorySelect.value;
    }
  } catch (e) {
    console.warn("Could not load state:", e);
  }
}
const debouncedSave = debounce(saveState, 500);

/* -------------------------
   Simple TTS
--------------------------*/
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = "en-IN";
    window.speechSynthesis.speak(u);
  } catch (e) {
    console.warn("TTS failed:", e);
  }
}

/* -------------------------
   Mic button (minimal)
--------------------------*/
(function maybeHookMicButton() {
  if (!taskInput) return;
  const parent = taskInput.parentElement;
  if (!parent) return;
  const existing = parent.querySelector("#mic-btn") || document.getElementById("mic-btn");
  if (existing) { existing.addEventListener("click", startVoiceInput); return; }
  parent.style.position = parent.style.position || "relative";
  const btn = document.createElement("button");
  btn.id = "mic-btn";
  btn.type = "button";
  btn.title = "Voice input";
  btn.textContent = "🎤";
  Object.assign(btn.style, { position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", border: "none", background: "transparent", cursor: "pointer" });
  parent.appendChild(btn);
  btn.addEventListener("click", startVoiceInput);
})();

async function startVoiceInput() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert("SpeechRecognition not supported");
    return;
  }
  if (!micPermissionGranted && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); micPermissionGranted = true; } catch (e) { alert("Mic permission denied"); return; }
  }
  try {
    recognition = new SR();
    recognition.lang = "en-IN";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    speak("Please tell your tasks separated by commas.");
    recognition.onresult = (ev) => {
      if (!ev.results || !ev.results[0] || !ev.results[0][0]) return;
      let raw = ev.results[0][0].transcript || "";
      raw = raw.replace(/\band\b/gi, ",").replace(/\bcomma\b/gi, ",").replace(/\s*,\s*/g, ",").trim();
      taskInput.value = raw;
      taskInput.focus();
    };
    recognition.onerror = (err) => { console.error("Speech recognition error:", err); speak("Couldn't hear clearly."); };
    recognition.onend = () => { recognition = null; };
    recognition.start();
  } catch (e) { console.error(e); }
}

/* -------------------------
   Parse tasks from input
--------------------------*/
function parseTasksFromInput(raw) {
  if (!raw) return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

/* -------------------------
   Robust Generator (simple, guaranteed)
   - Equal allocation across available minutes
   - Handles meals and short breaks
--------------------------*/
function generateSchedule_new() {
  try {
    if (!taskInput) return;
    const raw = String(taskInput.value || "").trim();
    if (!raw) { alert("Please enter tasks (comma-separated or use voice)."); return; }

    if (!startInput || !endInput || !startInput.value || !endInput.value) {
      alert("Please select start time and end time.");
      return;
    }

    const startMin = parseTime(startInput.value);
    const endMin = parseTime(endInput.value);
    if (Number.isNaN(startMin) || Number.isNaN(endMin) || endMin <= startMin) {
      alert("Invalid start or end time. Ensure end is after start and format is HH:MM.");
      return;
    }

    const userTasks = parseTasksFromInput(raw);
    if (!userTasks.length) { alert("Enter at least one task."); return; }

    // Config
    const MEAL_DURATION = 30;
    const MEALS = [
      { name: "Breakfast", time: parseTime("09:00") },
      { name: "Lunch", time: parseTime("13:00") },
      { name: "Dinner", time: parseTime("20:00") }
    ];
    const includeMeals = mealToggle && mealToggle.checked;
    const meals = includeMeals ? MEALS.filter(m => (m.time + MEAL_DURATION) > startMin && m.time < endMin) : [];

    // Build available intervals (subtract meals)
    let intervals = [{ s: startMin, e: endMin }];
    if (meals.length) {
      meals.forEach(m => {
        const mS = m.time;
        const mE = m.time + MEAL_DURATION;
        const newIntervals = [];
        intervals.forEach(iv => {
          if (mE <= iv.s || mS >= iv.e) {
            newIntervals.push(iv);
          } else {
            if (mS > iv.s) newIntervals.push({ s: iv.s, e: Math.min(iv.e, mS) });
            if (mE < iv.e) newIntervals.push({ s: Math.max(iv.s, mE), e: iv.e });
          }
        });
        intervals = newIntervals;
      });
    }

    // compute total available
    const totalAvailable = intervals.reduce((acc, iv) => acc + Math.max(0, iv.e - iv.s), 0);
    if (totalAvailable <= 0) { alert("No time available after accounting for meals."); return; }

    // Determine base allocation per task (ensures at least 1 minute if possible)
    const base = Math.floor(totalAvailable / userTasks.length);
    let remainder = totalAvailable - base * userTasks.length;

    // Build list of target durations (distribute remainder one minute to first tasks)
    const durations = userTasks.map((_, i) => base + (remainder > 0 ? 1 : 0));
    remainder = Math.max(0, remainder - userTasks.length);

    // If base is zero (very tight), ensure at least 1 minute allocated
    for (let i = 0; i < durations.length; i++) {
      if (durations[i] <= 0) durations[i] = 1;
    }

    // Walk intervals and allocate times
    const generated = [];
    let ivIndex = 0;
    let cursor = (intervals.length ? intervals[0].s : startMin);

    for (let t = 0; t < userTasks.length; t++) {
      let need = durations[t];
      const name = userTasks[t];
      while (need > 0 && ivIndex < intervals.length) {
        const iv = intervals[ivIndex];
        if (cursor >= iv.e) { ivIndex++; if (ivIndex < intervals.length) cursor = intervals[ivIndex].s; continue; }
        const available = iv.e - cursor;
        const take = Math.min(need, available);
        if (take > 0) {
          generated.push({ task: name, start: formatMin(cursor), end: formatMin(cursor + take), done: false });
          cursor += take;
          need -= take;
        } else {
          ivIndex++;
          if (ivIndex < intervals.length) cursor = intervals[ivIndex].s;
        }
      }

      // Insert short break if enabled and there's room in current interval
      if (shortToggle && shortToggle.checked) {
        if (ivIndex < intervals.length && cursor + 8 <= intervals[ivIndex].e) { // 8 minutes break
          generated.push({ task: "Short Break", start: formatMin(cursor), end: formatMin(cursor + 8), done: false, meta: { break: true } });
          cursor += 8;
        }
      }
    }

    // Add meals explicitly to output (so they show in timeline)
    if (includeMeals) {
      for (const m of meals) {
        if (m.time >= startMin && m.time + MEAL_DURATION <= endMin) {
          generated.push({ task: m.name, start: formatMin(m.time), end: formatMin(m.time + MEAL_DURATION), done: false, meta: { meal: true } });
        }
      }
    }

    // sort and merge contiguous same tasks
    generated.sort((a,b) => parseTime(a.start) - parseTime(b.start));
    const merged = [];
    for (const e of generated) {
      if (!merged.length) { merged.push(Object.assign({}, e)); continue; }
      const last = merged[merged.length - 1];
      if (parseTime(e.start) <= parseTime(last.end) + 1 && e.task === last.task) {
        last.end = formatMin(Math.max(parseTime(last.end), parseTime(e.end)));
      } else {
        merged.push(Object.assign({}, e));
      }
    }

    tasks = merged;
    console.log("Generated schedule:", tasks);
    renderTasks();
    updateProgress();
    updateScorecards();
    showSuggestion();
    debouncedSave();
    safe(() => outputBox && outputBox.scrollIntoView({ behavior: "smooth", block: "start" }));
  } catch (err) {
    console.error("generateSchedule_new error:", err);
    alert("An error occurred while generating schedule. Check console for details.");
  }
}

/* -------------------------
   Render tasks
--------------------------*/
function renderTasks() {
  if (!outputBox) return;
  outputBox.innerHTML = "";
  if (!tasks.length) {
    outputBox.innerHTML = "<p style='color:#999'>No tasks generated yet.</p>";
    return;
  }

  tasks.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "task-row";
    Object.assign(row.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "12px",
      marginBottom: "8px",
      borderRadius: "10px",
      background: "rgba(255,255,255,0.03)"
    });

    const left = document.createElement("div");
    left.innerHTML = `<strong style="display:block">${escapeHtml(t.start)} - ${escapeHtml(t.end)}</strong><div>${escapeHtml(t.task)}</div>`;

    const right = document.createElement("div");
    Object.assign(right.style, { display: "flex", alignItems: "center", gap: "8px" });

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "chk";
    cb.dataset.i = i;
    cb.style.width = "18px";
    cb.style.height = "18px";
    cb.checked = !!t.done;

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.title = "Edit task";
    editBtn.innerText = "✎";
    Object.assign(editBtn.style, { background: "transparent", border: "none", cursor: "pointer" });
    editBtn.addEventListener("click", () => {
      const newVal = prompt("Edit task name:", t.task);
      if (newVal !== null) { tasks[i].task = newVal.trim() || t.task; renderTasks(); updateScorecards(); renderTimeline(); debouncedSave(); }
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.title = "Delete task";
    delBtn.innerText = "🗑";
    Object.assign(delBtn.style, { background: "transparent", border: "none", cursor: "pointer" });
    delBtn.addEventListener("click", () => {
      if (!confirm("Delete this item?")) return;
      tasks.splice(i, 1);
      renderTasks();
      updateProgress();
      updateScorecards();
      renderTimeline();
      debouncedSave();
    });

    right.appendChild(cb);
    right.appendChild(editBtn);
    right.appendChild(delBtn);

    row.appendChild(left);
    row.appendChild(right);
    outputBox.appendChild(row);
  });

  const boxes = outputBox.querySelectorAll(".chk");
  boxes.forEach(b => {
    b.addEventListener("change", (e) => {
      const idx = Number(e.target.dataset.i);
      if (!Number.isFinite(idx)) return;
      tasks[idx].done = e.target.checked;
      if (e.target.checked && dingSound) safe(() => dingSound.play());
      updateProgress();
      updateScorecards();
      debouncedSave();
    });
  });

  renderTimeline();
}

/* -------------------------
   Progress, suggestions, scorecards
--------------------------*/
function updateProgress() {
  if (!progressFill) return;
  const done = tasks.filter(t => t.done).length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  progressFill.style.width = pct + "%";
}

function showSuggestion() {
  if (!suggestionBox) return;
  const tips = [
    "Start with the most difficult task.",
    "Take a 5-minute break every 45 minutes.",
    "Drink water to stay hydrated.",
    "Group similar tasks together.",
    "Use focused bursts (Pomodoro-like) for better concentration."
  ];
  suggestionBox.textContent = tips[Math.floor(Math.random() * tips.length)];
}

function updateScorecards() {
  if (!prodEl) return;
  const total = tasks.length;
  const completed = tasks.filter(t => t.done).length;
  const percent = total ? Math.round((completed / total) * 100) : 0;
  prodEl.innerText = percent + "%";
  if (compEl) compEl.innerText = `• Tasks completed: ${completed}/${total}`;
  if (aiEl) {
    const aiScore = Math.min(100, Math.round(percent * 0.6 + (total >= 3 ? 25 : 10)));
    aiEl.innerText = aiScore + "/100";
  }
}

/* -------------------------
   Timeline renderer
--------------------------*/
function renderTimeline() {
  if (!timelineBox) return;
  timelineBox.innerHTML = "";
  if (!tasks || tasks.length === 0) {
    timelineBox.innerHTML = "<p style='color:#999'>No timeline available.</p>";
    return;
  }

  const starts = tasks.map(t => parseTime(t.start));
  const ends = tasks.map(t => parseTime(t.end));
  const min = Math.min(...starts);
  const max = Math.max(...ends);
  const total = Math.max(1, max - min);

  const container = document.createElement("div");
  Object.assign(container.style, { display: "flex", gap: "6px", alignItems: "center", overflowX: "auto", padding: "6px" });

  tasks.forEach((t) => {
    const s = parseTime(t.start);
    const e = parseTime(t.end);
    const widthPx = Math.max(60, ((e - s) / total) * 320);
    const block = document.createElement("div");
    block.textContent = t.task;
    block.title = `${t.task} — ${t.start} to ${t.end}`;
    Object.assign(block.style, {
      padding: "8px",
      minWidth: `${widthPx}px`,
      borderRadius: "8px",
      fontSize: "12px",
      textAlign: "center",
      background: (t.meta && t.meta.break) ? "#f3f4f6" : "rgba(255,255,255,0.12)",
      border: "1px solid rgba(0,0,0,0.06)",
      cursor: "pointer",
      color: "white"
    });
    block.addEventListener("click", () => {
      for (let i = 0; i < tasks.length; i++) {
        if (tasks[i].task === t.task && tasks[i].start === t.start && tasks[i].end === t.end) {
          tasks[i].done = !tasks[i].done;
          renderTasks();
          updateProgress();
          updateScorecards();
          debouncedSave();
          break;
        }
      }
    });
    container.appendChild(block);
  });

  timelineBox.appendChild(container);
}

/* -------------------------
   Simple Chat UI (rule-based intelligence)
--------------------------*/
if (chatBtn && chatBox) {
  chatBtn.addEventListener("click", () => {
    if (chatBox.style.display === "block" || chatBox.classList.contains("open")) {
      chatBox.style.display = "none";
      chatBox.classList.remove("open");
    } else {
      chatBox.style.display = "block";
      chatBox.classList.add("open");
    }
  });
}
if (closeChatbot) {
  closeChatbot.addEventListener("click", () => {
    if (chatBox) { chatBox.style.display = "none"; chatBox.classList.remove("open"); }
  });
}
if (sendBtn && userInput) {
  sendBtn.addEventListener("click", sendMessage);
  userInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendMessage();
  });
}

function sendMessage() {
  if (!userInput || !chatMessages) return;
  let text = userInput.value.trim();
  if (!text) return;
  addUserMsg(text);
  userInput.value = "";
  setTimeout(() => {
    const reply = generateAIReply(text);
    addBotMsg(reply);
    // speak small replies optionally
    if (reply && reply.length < 200) safe(() => speak(reply));
  }, 300);
}
function addUserMsg(message) {
  if (!chatMessages) return;
  const msg = document.createElement("div");
  msg.className = "user-msg";
  msg.style.margin = "6px";
  msg.style.padding = "8px 10px";
  msg.style.background = "linear-gradient(90deg,#fff,#f3f3f3)";
  msg.style.color = "#111";
  msg.style.borderRadius = "10px";
  msg.style.maxWidth = "80%";
  msg.innerText = message;
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function addBotMsg(message) {
  if (!chatMessages) return;
  const msg = document.createElement("div");
  msg.className = "bot-msg";
  msg.style.margin = "6px";
  msg.style.padding = "8px 10px";
  msg.style.background = "rgba(255,255,255,0.06)";
  msg.style.color = "white";
  msg.style.borderRadius = "10px";
  msg.style.maxWidth = "80%";
  msg.innerHTML = message;
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/* A small util to compute simple math expressions safely */
function safeMathEval(expr) {
  // allow digits, spaces, + - * / % . ( )
  if (!/^[0-9+\-*/%.() \t]+$/.test(expr)) return null;
  try {
    // eslint-disable-next-line no-eval
    const val = eval(expr);
    if (Number.isFinite(val)) return val;
    return null;
  } catch (e) { return null; }
}

/* Chatbot knowledge & pattern matching */
function generateAIReply(query) {
  const q = String(query || "").trim();
  const ql = q.toLowerCase();

  // Greetings
  if (/\b(hi|hello|hey|good morning|good afternoon|good evening|greetings)\b/i.test(ql)) {
    return "Hello! 👋 I'm your schedule assistant. Ask me to generate a schedule, give tips, or ask general questions.";
  }

 // User struggling with planning / productivity
if (
  ql.includes("not able to plan") ||
  ql.includes("can't plan") ||
  ql.includes("cant plan") ||
  ql.includes("hard to plan") ||
  ql.includes("i am not able to plan") ||
  ql.includes("unable to plan") ||
  ql.includes("how should i plan") ||
  ql.includes("how to plan my day") ||
  ql.includes("plan my day")
) {
  return `
It’s okay, planning feels hard for many people ❤️<br><br>
Here’s a simple way to start:
1️⃣ List 3–5 important tasks (not everything).<br>
2️⃣ Set your start & end time in the app.<br>
3️⃣ Enter tasks like: <b>Study, Cleaning, Exercise</b>.<br>
4️⃣ Click <b>Generate</b> — I’ll split your day into easy blocks.<br><br>
Want me to help you decide which tasks to add? 🙂
`;
}


  // Time / date
  if (/\b(time|what time|current time)\b/.test(ql)) {
    const now = new Date();
    return `Current time: ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (/\b(date|today|what date|today's date)\b/.test(ql)) {
    const now = new Date();
    return `Today's date: ${now.toLocaleDateString()}`;
  }

  // Simple math
  const mathMatch = q.match(/^(?:calculate|what is|what's|eval)?\s*([0-9+\-*/%.() \t]+)\s*$/i);
  if (mathMatch && mathMatch[1]) {
    const ans = safeMathEval(mathMatch[1]);
    if (ans === null) return "I couldn't calculate that. Use only numbers and operators (+ - * / %).";
    return `Answer: ${ans}`;
  }

  // Ask how to use specific features
  if (ql.includes("export") || ql.includes("pdf")) {
    return "Click 'Export Schedule as PDF' to create a printable view. If PDF library isn't available, a print window will open for printing or saving as PDF.";
  }
  if (ql.includes("google") && ql.includes("calendar")) {
    return "Use 'Sync with Google Calendar' to open a pre-filled event for the first task — adjust as needed before saving to your Google Calendar.";
  }

  // Ask about voice input
  if (ql.includes("voice") || ql.includes("mic") || ql.includes("microphone")) {
    return "Click the 🎤 button next to the Tasks input to speak your tasks. Speak tasks separated by commas (e.g. Gym, Study, Reading).";
  }

  // Ask to clear or reset
  if (ql.includes("reset") || ql.includes("clear") || ql.includes("delete schedule")) {
    return "To reset, click the Reset button. That will clear the inputs and remove the generated schedule.";
  }

  // Ask for definitions or summaries (fallback generic)
  if (ql.startsWith("what is ") || ql.startsWith("who is ") || ql.startsWith("define ")) {
    // lightweight local fallback: instruct the user to search online
    return "I can give a short explanation if it's a common concept, or you can try a web search for detailed info. Ask me a short topic and I'll try to summarize.";
  }

  // If user asks "how many tasks", or task-based queries
  if (/\bhow many tasks\b/.test(ql)) {
    return `You have ${tasks.length} scheduled item(s).`;
  }

  // If user asks to mark task complete by name or number
  const markMatch = ql.match(/\b(mark|complete|done)\b.*\b(task\s*)?(\d+)\b/);
  if (markMatch) {
    const idx = Number(markMatch[3]) - 1;
    if (tasks[idx]) {
      tasks[idx].done = true;
      debouncedSave();
      renderTasks();
      updateProgress();
      return `Marked task ${idx+1} (${tasks[idx].task}) as done.`;
    } else {
      return "I couldn't find that task number.";
    }
  }

  // Generic fallback improvements:
  // try simple known phrases
  if (ql.includes("help")) {
    return "I can help with: generating schedules, giving productivity tips, playing small TTS replies, or doing simple math. Try: 'How do I generate a schedule?' or 'Calculate 12*8'.";
  }

  // Very flexible fallback (attempt to be helpful)
  // If a short question, return an encouraging/nice reply
  if (ql.length < 120) {
    const fallbackAnswers = [
      "That's interesting — can you give more detail? I can help with scheduling, tips, or simple calculations.",
      "I don't have an exact answer for that offline, but I can help you plan or explain concepts. What would you like to do?",
      "I can help with your schedule, give productivity tips, or do quick math. Try 'show schedule' or 'give me a focus tip'."
    ];
    return fallbackAnswers[Math.floor(Math.random() * fallbackAnswers.length)];
  }

  // Last-resort: echo + invite more clarity
  return "I didn't quite get that. Try asking specifically about your schedule, tips, or a short question I can compute (like 'Calculate 12/3').";
}

/* -------------------------
   Notifications (kept)
--------------------------*/
function sendBrowserNotification(title, body) {
  if (Notification.permission === "granted") {
    try { new Notification(title, { body: body }); } catch (e) { console.warn(e); }
  }
}
function sendInAppNotification(message) {
  const box = document.createElement("div");
  box.className = "app-notify";
  box.innerText = message;
  Object.assign(box.style, { position: "fixed", right: "20px", bottom: "20px", background: "#111827", color: "#fff", padding: "10px 12px", borderRadius: "8px", zIndex: 9999 });
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 5000);
}
function notify(title, message) {
  sendBrowserNotification(title, message);
  sendInAppNotification(message);
}
function ensureTaskMeta(t) {
  if (!t.meta) t.meta = {};
  if (!t.meta._notified) t.meta._notified = {};
}

/* Task scheduling notifier: check every 30s (safer for demo) */
setInterval(() => {
  if (!tasks || tasks.length === 0) return;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  tasks.forEach(t => {
    ensureTaskMeta(t);
    const startMin = hhmmToMin(t.start);
    const endMin = hhmmToMin(t.end);
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) return;
    if (nowMin === startMin - 5 && !t.meta._notified['rem5']) { notify("Upcoming Task", `${t.task} will start in 5 minutes.`); t.meta._notified['rem5'] = true; }
    if (nowMin === startMin && !t.meta._notified['start']) { notify("Task Started", `It's time to start: ${t.task}`); t.meta._notified['start'] = true; }
    if (nowMin === startMin + 2 && !t.meta._notified['miss']) { if (!t.done) notify("Missed Task", `You missed the start time for: ${t.task}`); t.meta._notified['miss'] = true; }
    if (nowMin === endMin && !t.meta._notified['end']) { if (!t.done) notify("Task Incomplete", `The time for ${t.task} has ended.`); t.meta._notified['end'] = true; }
  });
}, 30 * 1000);

/* Break notifier */
setInterval(() => {
  const now = new Date();
  const min = now.getMinutes();
  if (min === 55) notify("Break Time", "Take a short 5-minute break!");
  if (min === 0) notify("Break Over", "Break over! Continue your tasks.");
}, 60 * 1000);

/* -------------------------
   Add-ons: Export / Share / GCal
--------------------------*/
if (exportBtn) {
  exportBtn.addEventListener("click", () => {
    if (!tasks.length) return alert("No schedule to export!");
    const jsPDF = window.jspdf && (window.jspdf.jsPDF || window.jspdf);
    if (jsPDF) {
      const doc = new jsPDF.jsPDF ? new jsPDF.jsPDF() : new jsPDF();
      doc.setFontSize(16);
      doc.text("My Study Schedule", 14, 20);
      let y = 35;
      tasks.forEach((t, i) => { doc.setFontSize(11); doc.text(`${i + 1}. ${t.task} — ${t.start} - ${t.end}`, 14, y); y += 8; if (y > 270) { doc.addPage(); y = 20; } });
      doc.save("schedule.pdf");
      return;
    }
    const popup = window.open('', '_blank');
    if (!popup) return alert('Pop-up blocked.');
    const style = `<style>body{font-family: Arial; padding:20px;} li{margin:8px 0;}</style>`;
    const html = `<!doctype html><html><head><meta charset="utf-8">${style}</head><body><h1>Schedule — ${dateInput ? escapeHtml(dateInput.value) : ''}</h1><ol>${tasks.map(t => `<li><strong>${escapeHtml(t.task)}</strong> — ${escapeHtml(t.start)} to ${escapeHtml(t.end)}</li>`).join('')}</ol><script>window.onload=function(){window.print();}</script></body></html>`;
    popup.document.write(html);
    popup.document.close();
  });
}
if (shareBtn) {
  shareBtn.addEventListener("click", () => {
    if (!tasks.length) return alert("No schedule to share!");
    const payload = { tasks, date: dateInput ? dateInput.value : (new Date().toISOString().slice(0,10)) };
    const data = encodeURIComponent(JSON.stringify(payload));
    const url = location.origin + location.pathname + "#schedule=" + data;
    if (navigator.share) navigator.share({ title: "My Schedule", text: "Open my schedule", url }).catch(() => prompt("Copy link:", url));
    else prompt("Copy link:", url);
  });
  safe(() => {
    if (location.hash && location.hash.startsWith("#schedule=")) {
      try {
        const encoded = location.hash.replace("#schedule=", "");
        const decoded = decodeURIComponent(encoded);
        const payload = JSON.parse(decoded);
        if (payload && Array.isArray(payload.tasks) && !tasks.length) {
          tasks = payload.tasks;
          renderTasks();
          updateProgress();
          updateScorecards();
          debouncedSave();
        }
      } catch (e) {}
    }
  });
}
if (gcalBtn) {
  gcalBtn.addEventListener("click", () => {
    if (!tasks.length) return alert("Add a task to sync.");
    const t = tasks[0];
    const title = encodeURIComponent(t.task);
    const details = encodeURIComponent(`Planned via AI Schedule Generator — ${t.start} to ${t.end}`);
    function buildLocalGCalDate(dateStr, hhmm) {
      const date = dateStr ? new Date(dateStr + "T00:00:00") : new Date();
      const [h, m] = hhmm.split(":").map(Number);
      date.setHours(h, m, 0, 0);
      const YYYY = date.getFullYear();
      const MM = String(date.getMonth() + 1).padStart(2, "0");
      const DD = String(date.getDate()).padStart(2, "0");
      const hh = String(date.getHours()).padStart(2, "0");
      const mm = String(date.getMinutes()).padStart(2, "0");
      const ss = "00";
      return `${YYYY}${MM}${DD}T${hh}${mm}${ss}`;
    }
    const dateStr = dateInput ? dateInput.value : new Date().toISOString().slice(0,10);
    const gStart = buildLocalGCalDate(dateStr, t.start);
    const gEnd = buildLocalGCalDate(dateStr, t.end);
    const url = `https://calendar.google.com/calendar/r/eventedit?text=${title}&details=${details}&dates=${gStart}/${gEnd}`;
    window.open(url, "_blank");
  });
}

/* -------------------------
   Reset / Init
--------------------------*/
if (resetBtn) {
  resetBtn.addEventListener("click", () => {
    if (!confirm("Reset everything?")) return;
    if (taskInput) taskInput.value = "";
    if (startInput) startInput.value = "";
    if (endInput) endInput.value = "";
    if (outputBox) outputBox.innerHTML = "";
    if (suggestionBox) suggestionBox.innerHTML = "";
    if (progressFill) progressFill.style.width = "0%";
    tasks = [];
    updateScorecards();
    renderTimeline();
    debouncedSave();
  });
}

/* Backwards-compatible small helper so any external call to generateSchedule() still works */
function generateSchedule() { return generateSchedule_new(); }

/* If user used an old inline onclick or other listener, override to ensure proper binding */
if (generateBtn) {
  generateBtn.removeAttribute && generateBtn.removeAttribute("onclick");
  const newGen = generateBtn.cloneNode(true);
  generateBtn.parentNode.replaceChild(newGen, generateBtn);
  newGen.addEventListener("click", generateSchedule_new);
}

/* -------------------------
   renderSchedule helper for older code
--------------------------*/
function renderSchedule(timeline) {
  if (!Array.isArray(timeline)) return;
  tasks = timeline.map(item => {
    const s = (typeof item.start === "number") ? formatMin(item.start) : (typeof item.start === "string" ? (isNaN(parseTime(item.start)) ? item.start : formatMin(parseTime(item.start))) : "");
    const e = (typeof item.end === "number") ? formatMin(item.end) : (typeof item.end === "string" ? (isNaN(parseTime(item.end)) ? item.end : formatMin(parseTime(item.end))) : "");
    return { task: String(item.task || "Untitled"), start: s, end: e, done: !!item.done, meta: item.meta || {} };
  });
  tasks.sort((a,b) => parseTime(a.start) - parseTime(b.start));
  renderTasks();
  updateProgress();
  updateScorecards();
  debouncedSave();
}

/* -------------------------
   DAILY REMINDER NOTIFICATION BLOCK (Matches your HTML)
   Button: <button id="dailyNotify">Enable Daily Reminder Notifications</button>
--------------------------*/
const dailyNotifyBtn = document.getElementById("dailyNotify");

// Store notification timer
let dailyReminderInterval = null;

// Request permission + start reminder
async function enableDailyNotification() {
  const permission = await Notification.requestPermission();

  if (permission !== "granted") {
    alert("Please allow notifications to enable daily reminders.");
    return;
  }

  // Clear if already running
  if (dailyReminderInterval) {
    clearInterval(dailyReminderInterval);
  }

  // Example daily reminder time → 9:00 AM (changeable)
  const reminderHour = 9;
  const reminderMinute = 0;

  dailyReminderInterval = setInterval(() => {
    const now = new Date();
    if (now.getHours() === reminderHour && now.getMinutes() === reminderMinute) {
      new Notification("Daily Reminder", {
        body: "Don’t forget to check your schedule for today!",
        icon: "https://cdn-icons-png.flaticon.com/512/1827/1827370.png"
      });
    }
  }, 30 * 1000);  // checks every 30 seconds

  if (dailyNotifyBtn) {
    dailyNotifyBtn.textContent = "Daily Reminder Enabled";
    dailyNotifyBtn.style.background = "#22c55e";
  }
}

// Attach event
if (dailyNotifyBtn) {
  dailyNotifyBtn.addEventListener("click", enableDailyNotification);
}

/* -------------------------
   Initialization flow
--------------------------*/
loadState();
showSuggestion();
updateScorecards();
renderTimeline();

/* On unload, persist state */
window.addEventListener("beforeunload", saveState);

/* Small UX: Allow clicking on output to copy task text */
if (outputBox) {
  outputBox.addEventListener("dblclick", (e) => {
    const el = e.target.closest(".task-row");
    if (!el) return;
    const idx = Array.from(outputBox.children).indexOf(el);
    if (idx >= 0 && tasks[idx]) {
      navigator.clipboard && navigator.clipboard.writeText(`${tasks[idx].task} — ${tasks[idx].start} to ${tasks[idx].end}`).then(() => {
        sendInAppNotification("Copied to clipboard");
      }).catch(()=>{/* ignore */});
    }
  });
}

/* End of file */
