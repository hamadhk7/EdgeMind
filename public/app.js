// EdgeMind web client: guest session, conversations, documents, memory, usage,
// and a live view of the agent team over the orchestrator's WebSocket.

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
};
const svg = (paths) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.innerHTML = paths;
  return s;
};

const ICONS = {
  research: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  rag: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  caret: '<path d="m9 18 6-6-6-6"/>',
};
const STATUS_LABEL = {
  pending: "waiting",
  queued: "queued",
  running: "working",
  completed: "done",
  failed: "failed",
  timed_out: "timed out",
};

const state = {
  token: null,
  userId: null,
  conversations: [],
  current: null,
  socket: null,
  reconnectDelay: 500,
  mode: "auto",
  runs: new Map(),
  busy: false,
  docPoll: null,
};

// ------------------------------------------------------------------- API

async function api(path, options = {}, retry = true) {
  const headers = new Headers(options.headers);
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && retry) {
    await newSession();
    return api(path, options, false);
  }
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

async function newSession() {
  state.token = null;
  const body = await api("/api/session", { method: "POST" }, false);
  state.token = body.token;
  state.userId = body.userId;
  storage("edgemind.token", body.token);
}

async function ensureSession() {
  const saved = storage("edgemind.token");
  if (saved) {
    state.token = saved;
    try {
      // Refresh keeps the same guest identity (and its conversations) for another day.
      const body = await api("/api/session", { method: "POST" }, false);
      state.token = body.token;
      state.userId = body.userId;
      storage("edgemind.token", body.token);
      return;
    } catch {
      storage("edgemind.token", null);
    }
  }
  await newSession();
}

// --------------------------------------------------------------- toasts

function toast(message, kind = "info") {
  const t = el("div", { class: `toast ${kind}`, text: message });
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 5000);
}

// -------------------------------------------------------- conversations

async function loadConversations() {
  const { conversations } = await api("/api/conversations");
  state.conversations = conversations;
  renderConversations();
  return conversations;
}

function renderConversations() {
  const list = $("#conversations");
  list.replaceChildren();
  if (!state.conversations.length) {
    list.append(el("li", { class: "empty", text: "No conversations yet." }));
    return;
  }
  for (const c of state.conversations) {
    list.append(
      el(
        "li",
        {
          class: `item ${state.current?.id === c.id ? "active" : ""}`,
          onclick: () => openConversation(c),
          title: c.title,
        },
        el("span", { class: "label", text: c.title }),
      ),
    );
  }
}

async function createConversation() {
  const { conversation } = await api("/api/conversations", { method: "POST" });
  state.conversations.unshift(conversation);
  openConversation(conversation);
}

function openConversation(conversation) {
  state.current = conversation;
  state.runs.clear();
  state.busy = false;
  updateComposer();
  $("#title").textContent = conversation.title;
  $("#messages").replaceChildren(welcomeNode);
  welcomeNode.hidden = false;
  renderConversations();
  storage("edgemind.conversation", conversation.id);
  $("#sidebar").classList.remove("open");
  connect();
}

// ------------------------------------------------------------ WebSocket

function setStatus(kind, text) {
  const s = $("#status");
  s.className = `status ${kind}`;
  s.querySelector(".status-text").textContent = text;
}

function connect() {
  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
  }
  const conversation = state.current;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}${conversation.agentPath}?token=${encodeURIComponent(state.token)}`);
  state.socket = ws;
  setStatus("", "Connecting");

  ws.onopen = () => {
    state.reconnectDelay = 500;
    setStatus("online", "Connected");
  };
  ws.onmessage = (msg) => {
    let event;
    try {
      event = JSON.parse(msg.data);
    } catch {
      return;
    }
    handleEvent(event);
  };
  ws.onclose = () => {
    if (state.socket !== ws || state.current !== conversation) return;
    setStatus("offline", "Reconnecting");
    setTimeout(() => state.current === conversation && connect(), state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 8000);
  };
}

function send(text, mode) {
  if (!text.trim() || state.busy) return;
  if (state.socket?.readyState !== WebSocket.OPEN) {
    toast("Not connected yet, try again in a moment", "error");
    return;
  }
  state.socket.send(JSON.stringify({ type: "chat", text, mode }));
  state.busy = true;
  updateComposer();
}

function handleEvent(event) {
  switch (event.type) {
    case "history":
      renderHistory(event.messages);
      break;
    case "run_started":
      onRunStarted(event);
      break;
    case "plan":
      onPlan(event);
      break;
    case "subtask":
      onSubtask(event);
      break;
    case "research_progress":
      onProgress(event);
      break;
    case "token":
      onToken(event);
      break;
    case "final":
      onFinal(event);
      break;
    case "error":
      onError(event);
      break;
    default:
      // Agents SDK protocol frames (identity, state sync) are not used by this UI.
      break;
  }
}

// -------------------------------------------------------------- render

const welcomeNode = $("#welcome");

function scrollToBottom() {
  const box = $("#messages");
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 240) box.scrollTop = box.scrollHeight;
}

function markdown(text, sources = []) {
  const container = el("div", { class: "md" });
  const html = window.marked ? window.marked.parse(text ?? "", { breaks: true }) : null;
  if (html && window.DOMPurify) container.innerHTML = window.DOMPurify.sanitize(html);
  else container.textContent = text ?? "";
  linkCitations(container, sources);
  return container;
}

/** Turns [n] markers into links to the matching source. */
function linkCitations(root, sources) {
  if (!sources.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("pre, code, a") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) if (/\[\d+\]/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    node.nodeValue.replace(/\[(\d+)\]/g, (match, n, offset) => {
      const source = sources[Number(n) - 1];
      if (!source) return match;
      frag.append(node.nodeValue.slice(last, offset));
      frag.append(
        el("a", {
          class: "cite",
          text: n,
          href: source.url ?? "#",
          target: source.url ? "_blank" : undefined,
          rel: "noopener noreferrer",
          title: source.title,
        }),
      );
      last = offset + match.length;
      return match;
    });
    frag.append(node.nodeValue.slice(last));
    node.replaceWith(frag);
  }
}

function sourcesNode(sources) {
  if (!sources?.length) return null;
  return el(
    "div",
    { class: "sources" },
    sources.map((s, i) =>
      el(
        s.url ? "a" : "span",
        { class: "source", href: s.url, target: s.url ? "_blank" : undefined, rel: "noopener noreferrer", title: s.title },
        el("b", { text: `${i + 1}` }),
        el("span", { text: s.title }),
      ),
    ),
  );
}

function userMessage(text) {
  return el("div", { class: "msg user" }, el("div", { class: "bubble", text }));
}

function assistantMessage(content, sources = []) {
  const bubble = el("div", { class: "bubble" }, markdown(content, sources), sourcesNode(sources));
  return el("div", { class: "msg assistant" }, bubble);
}

function renderHistory(messages) {
  const box = $("#messages");
  box.replaceChildren(welcomeNode);
  welcomeNode.hidden = messages.length > 0;
  for (const m of messages) box.append(m.role === "user" ? userMessage(m.content) : assistantMessage(m.content, m.sources));
  box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------- run events

function getRun(runId) {
  let run = state.runs.get(runId);
  if (run) return run;

  const summaryText = el("span", { text: "Planning…" });
  const trace = el(
    "details",
    { class: "trace", open: true },
    el("summary", {}, el("span", { class: "caret" }, svg(ICONS.caret)), el("span", { class: "spinner" }), summaryText),
  );
  const body = el("div", { class: "trace-body" });
  trace.append(body);
  const bubble = el("div", { class: "bubble", hidden: true });
  const node = el("div", { class: "msg assistant" }, trace, bubble);
  $("#messages").append(node);

  run = { node, trace, body, summaryText, bubble, cards: new Map(), text: "", renderPending: false, progress: null };
  state.runs.set(runId, run);
  return run;
}

function onRunStarted(event) {
  welcomeNode.hidden = true;
  $("#messages").append(userMessage(event.text));
  getRun(event.runId);
  state.busy = true;
  updateComposer();
  scrollToBottom();
}

function onPlan(event) {
  const run = getRun(event.runId);
  const labels = { direct: "Answering directly", delegate: "Delegating to agents", deep_research: "Deep research" };
  run.summaryText.textContent = labels[event.mode] ?? event.mode;
  run.body.replaceChildren();
  run.body.append(
    el(
      "div",
      {},
      el("span", { class: "mode-tag", text: event.mode }),
      " ",
      event.rationale ? el("span", { class: "rationale", text: event.rationale }) : null,
    ),
  );

  if (event.subtasks.length) {
    const grid = el("div", { class: "agents" });
    const shortId = (id) => id.split("_").pop();
    for (const s of event.subtasks) {
      const badge = el("span", { class: "badge pending", text: STATUS_LABEL.pending });
      const output = el("div");
      const card = el(
        "div",
        { class: "agent-card" },
        el(
          "div",
          { class: "agent-head" },
          el("span", { class: "agent-icon" }, svg(ICONS[s.agent] ?? ICONS.research)),
          el("span", { class: "agent-name", text: `${s.agent} · ${shortId(s.id)}` }),
          badge,
        ),
        el("div", { class: "agent-input", text: s.input, title: s.input }),
        s.dependsOn.length ? el("div", { class: "agent-deps", text: `after ${s.dependsOn.map(shortId).join(", ")}` }) : null,
        output,
      );
      run.cards.set(s.id, { card, badge, output });
      grid.append(card);
    }
    run.body.append(grid);
  }
  if (event.mode === "deep_research") {
    run.progress = { log: el("ol", { class: "progress-log" }), fill: el("div", { class: "meter-fill" }) };
    run.body.append(el("div", { class: "progress" }, el("div", { class: "meter" }, run.progress.fill), run.progress.log));
  }
  scrollToBottom();
}

function onSubtask(event) {
  const run = getRun(event.runId);
  const entry = run.cards.get(event.taskId);
  if (!entry) return;
  entry.badge.className = `badge ${event.status}`;
  entry.badge.textContent = STATUS_LABEL[event.status] ?? event.status;
  entry.card.classList.toggle("running", event.status === "running");
  if (event.output || event.error) {
    entry.output.replaceChildren(
      el(
        "details",
        { class: "agent-output" },
        el("summary", { text: event.error ? "Show error" : "Show result" }),
        markdown(event.error ?? event.output, event.sources ?? []),
      ),
    );
  }
}

function onProgress(event) {
  const run = getRun(event.runId);
  if (!run.progress) return;
  run.progress.log.append(el("li", { text: event.message }));
  if (typeof event.percent === "number") run.progress.fill.style.width = `${Math.round(event.percent * 100)}%`;
  run.summaryText.textContent = event.message;
  scrollToBottom();
}

function onToken(event) {
  const run = getRun(event.runId);
  if (run.finalized) return;
  run.text += event.text;
  run.bubble.hidden = false;
  run.bubble.classList.add("streaming");
  if (run.renderPending) return;
  run.renderPending = true;
  requestAnimationFrame(() => {
    run.renderPending = false;
    if (run.finalized) return;
    run.bubble.replaceChildren(markdown(run.text));
    scrollToBottom();
  });
}

function onFinal(event) {
  const run = getRun(event.runId);
  run.finalized = true;
  run.trace.classList.add("done");
  run.trace.open = false;
  run.summaryText.textContent = `${run.summaryText.textContent} · done`;
  run.bubble.hidden = false;
  run.bubble.classList.remove("streaming");
  run.bubble.replaceChildren(
    markdown(event.content, event.sources),
    event.reportUrl
      ? el("button", { class: "btn small ghost report-link", text: "Download full report", onclick: () => downloadReport(event.reportUrl) })
      : null,
    sourcesNode(event.sources),
  );
  state.busy = false;
  updateComposer();
  scrollToBottom();
  refreshSidebar();
}

function onError(event) {
  toast(event.message, "error");
  if (event.code === "run_in_progress") return;
  if (event.runId) {
    const run = getRun(event.runId);
    run.trace.classList.add("done");
    run.summaryText.textContent = `Failed: ${event.message}`;
  }
  state.busy = false;
  updateComposer();
}

async function downloadReport(url) {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${state.token}` } });
    if (!res.ok) throw new Error("Report not found");
    const blob = await res.blob();
    const link = el("a", { href: URL.createObjectURL(blob), download: url.split("/").pop() + ".md" });
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (err) {
    toast(err.message, "error");
  }
}

// -------------------------------------------- documents, memory, usage

async function loadDocuments() {
  const { documents } = await api("/api/documents");
  const list = $("#documents");
  list.replaceChildren();
  if (!documents.length) {
    list.append(el("li", { class: "empty", text: "Upload files and the RAG agent will search them." }));
  }
  for (const d of documents) {
    const status = d.status === "ready" ? `${d.chunkCount} chunks` : d.status;
    list.append(
      el(
        "li",
        { title: d.error ?? d.filename },
        el("span", { class: "label", text: d.filename }),
        el("span", { class: `badge ${d.status === "ready" ? "completed" : d.status === "failed" ? "failed" : "running"}`, text: status }),
        el("button", { class: "x", title: "Delete", onclick: () => deleteDocument(d.id) }, svg(ICONS.x)),
      ),
    );
  }
  const processing = documents.some((d) => d.status === "queued" || d.status === "processing");
  clearTimeout(state.docPoll);
  if (processing) state.docPoll = setTimeout(loadDocuments, 2500);
}

async function upload(file) {
  const form = new FormData();
  form.append("file", file);
  try {
    await api("/api/documents", { method: "POST", body: form });
    toast(`Uploading ${file.name}. Ingestion runs as a Workflow.`);
    loadDocuments();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function deleteDocument(id) {
  await api(`/api/documents/${id}`, { method: "DELETE" });
  loadDocuments();
}

async function loadMemories() {
  const { memories } = await api("/api/memories");
  const list = $("#memories");
  list.replaceChildren();
  if (!memories.length) list.append(el("li", { class: "empty", text: "Durable facts the agents learn about you appear here." }));
  for (const m of memories) {
    list.append(
      el(
        "li",
        { title: m.text },
        el("span", { class: "label", text: m.text }),
        el("button", { class: "x", title: "Forget", onclick: () => forget(m.id) }, svg(ICONS.x)),
      ),
    );
  }
}

async function forget(id) {
  await api(`/api/memories/${id}`, { method: "DELETE" });
  loadMemories();
}

async function loadUsage() {
  const me = await api("/api/me");
  const { tokensToday, dailyBudget } = me.usage;
  $("#usage-text").textContent = `${tokensToday.toLocaleString()} / ${dailyBudget.toLocaleString()}`;
  $("#usage-fill").style.width = `${Math.min(100, (tokensToday / dailyBudget) * 100)}%`;
}

function refreshSidebar() {
  loadUsage().catch(() => {});
  loadConversations().then(() => {
    const current = state.conversations.find((c) => c.id === state.current?.id);
    if (current) $("#title").textContent = current.title;
  });
  // Memory distillation runs after the answer; give it a moment.
  setTimeout(() => loadMemories().catch(() => {}), 2500);
}

// ------------------------------------------------------------ composer

function updateComposer() {
  $("#send").disabled = state.busy;
  $("#input").placeholder = state.busy ? "The agents are working…" : "Message the agents…";
}

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll(".mode-btn")) {
    const active = b.dataset.mode === mode;
    b.classList.toggle("active", active);
    b.setAttribute("aria-checked", String(active));
  }
}

function bindUi() {
  const input = $("#input");
  const autosize = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  };
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("#composer").requestSubmit();
    }
  });
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || state.busy) return;
    send(text, state.mode);
    input.value = "";
    autosize();
  });
  for (const b of document.querySelectorAll(".mode-btn")) b.addEventListener("click", () => setMode(b.dataset.mode));
  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      setMode(chip.dataset.mode ?? "auto");
      send(chip.dataset.prompt, chip.dataset.mode ?? "auto");
    });
  }
  $("#new-chat").addEventListener("click", () => createConversation().catch((err) => toast(err.message, "error")));
  $("#upload").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) upload(file);
    e.target.value = "";
  });
  $("#menu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
}

// ----------------------------------------------------------------- boot

async function boot() {
  bindUi();
  try {
    await ensureSession();
    const conversations = await loadConversations();
    const savedId = storage("edgemind.conversation");
    const saved = conversations.find((c) => c.id === savedId) ?? conversations[0];
    if (saved) openConversation(saved);
    else await createConversation();
    loadDocuments().catch(() => {});
    loadMemories().catch(() => {});
    loadUsage().catch(() => {});
  } catch (err) {
    setStatus("offline", "Unavailable");
    toast(`Could not start: ${err.message}`, "error");
  }
}

boot();
