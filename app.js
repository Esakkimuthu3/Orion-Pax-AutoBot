/* ==========================================================================
   ORION PAX — free edition
   A custom front end that talks directly to Google's Gemini API from the
   browser, using the visitor's own free API key (BYOK pattern). No backend,
   no proxy, $0 cost — deployable as a static site (e.g. GitHub Pages).
   ========================================================================== */

(function () {
  "use strict";

  /* ---------------------------------------------------------------------
     Config & storage helpers
     --------------------------------------------------------------------- */
  const STORAGE_KEYS = {
    settings: "orionpax_settings_v2_gemini",
    conversations: "orionpax_conversations_v2_gemini",
  };

  const DEFAULT_SETTINGS = {
    apiKey: "",
    model: "gemini-3.5-flash",
    customModel: "",
    systemPrompt:
      "You are Orion Pax, a precise and direct AI assistant. Give exact, " +
      "well-reasoned answers. When writing code, produce complete, correct, " +
      "runnable code with clear explanations. When asked to edit an attached " +
      "file, return the full corrected content, not just a diff, unless a " +
      "diff is explicitly requested. Say when you are uncertain rather than " +
      "guessing.",
    maxTokens: 4096,
    temperature: 0.7,
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.settings);
      return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(settings) {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  }

  function loadConversations() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.conversations);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function persistConversations() {
    // Keep at most 50 conversations, and strip heavy base64 image/pdf
    // payloads before saving — they'd blow the ~5MB localStorage quota fast.
    // Full data stays in memory for the live session; only the light copy
    // (text + attachment names) survives a reload.
    const trimmed = state.conversations.slice(0, 50).map((c) => ({
      ...c,
      messages: c.messages.map((m) => ({
        ...m,
        apiParts: (m.apiParts || []).map((part) =>
          part.inlineData
            ? { text: `[attachment "${m.attachmentsMeta?.[0]?.name || "file"}" omitted from saved history]` }
            : part
        ),
      })),
    }));
    try {
      localStorage.setItem(STORAGE_KEYS.conversations, JSON.stringify(trimmed));
    } catch (err) {
      console.warn("Orion Pax: could not persist conversation history (storage full?)", err);
    }
  }

  /* ---------------------------------------------------------------------
     State
     --------------------------------------------------------------------- */
  const state = {
    settings: loadSettings(),
    conversations: loadConversations(), // [{id, title, messages: [{role, apiParts, text, attachmentsMeta}]}]
    currentId: null,
    pendingAttachments: [], // [{name, mediaType, kind: 'image'|'file'|'text', data, size}]
    streaming: false,
  };

  /* ---------------------------------------------------------------------
     DOM refs
     --------------------------------------------------------------------- */
  const $ = (id) => document.getElementById(id);

  const el = {
    historyList: $("historyList"),
    newChatBtn: $("newChatBtn"),
    modelPill: $("modelPill"),
    settingsBtn: $("settingsBtn"),
    exportBtn: $("exportBtn"),
    clearBtn: $("clearBtn"),
    transcript: $("transcript"),
    emptyState: $("emptyState"),
    composerForm: $("composerForm"),
    attachmentsBar: $("attachmentsBar"),
    attachBtn: $("attachBtn"),
    fileInput: $("fileInput"),
    promptInput: $("promptInput"),
    sendBtn: $("sendBtn"),
    sendLabel: $("sendLabel"),
    statusDot: $("statusDot"),
    statusText: $("statusText"),
    sparkCore: $("sparkCore"),

    settingsBackdrop: $("settingsBackdrop"),
    closeSettingsBtn: $("closeSettingsBtn"),
    apiKeyInput: $("apiKeyInput"),
    modelSelect: $("modelSelect"),
    customModelInput: $("customModelInput"),
    systemPromptInput: $("systemPromptInput"),
    maxTokensInput: $("maxTokensInput"),
    temperatureInput: $("temperatureInput"),
    saveSettingsBtn: $("saveSettingsBtn"),
  };

  const MODEL_LABELS = {
    "gemini-3.5-flash": "GEMINI 3.5 FLASH",
    "gemini-2.5-flash": "GEMINI 2.5 FLASH",
    "gemini-2.5-flash-lite": "GEMINI 2.5 FLASH-LITE",
  };

  function activeModel() {
    return (state.settings.customModel || "").trim() || state.settings.model;
  }

  function modelLabel() {
    const m = activeModel();
    return MODEL_LABELS[m] || m.toUpperCase();
  }

  /* ---------------------------------------------------------------------
     Markdown rendering
     --------------------------------------------------------------------- */
  if (window.marked) {
    marked.setOptions({ breaks: true, gfm: true });
  }

  function renderMarkdown(text) {
    const rawHtml = window.marked ? marked.parse(text) : escapeHtml(text);
    const clean = window.DOMPurify ? DOMPurify.sanitize(rawHtml) : rawHtml;
    return clean;
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function decorateCodeBlocks(container) {
    container.querySelectorAll("pre code").forEach((block) => {
      if (window.hljs) {
        try { hljs.highlightElement(block); } catch { /* ignore */ }
      }
      const pre = block.parentElement;
      if (pre.querySelector(".code-copy-btn")) return;

      const langMatch = [...block.classList].find((c) => c.startsWith("language-"));
      if (langMatch) {
        const tag = document.createElement("span");
        tag.className = "code-lang";
        tag.textContent = langMatch.replace("language-", "");
        pre.appendChild(tag);
      }

      const btn = document.createElement("button");
      btn.className = "code-copy-btn";
      btn.type = "button";
      btn.textContent = "COPY";
      btn.addEventListener("click", () => {
        navigator.clipboard.writeText(block.textContent).then(() => {
          btn.textContent = "COPIED";
          setTimeout(() => (btn.textContent = "COPY"), 1200);
        });
      });
      pre.appendChild(btn);
    });
  }

  /* ---------------------------------------------------------------------
     Conversation helpers
     --------------------------------------------------------------------- */
  function getCurrentConversation() {
    return state.conversations.find((c) => c.id === state.currentId) || null;
  }

  function createConversation() {
    const convo = { id: crypto.randomUUID(), title: "New chat", messages: [] };
    state.conversations.unshift(convo);
    state.currentId = convo.id;
    persistConversations();
    renderHistory();
    renderTranscript();
  }

  function ensureConversation() {
    if (!getCurrentConversation()) createConversation();
    return getCurrentConversation();
  }

  function setConversationTitleFromFirstMessage(convo, text) {
    if (convo.title !== "New chat") return;
    const clean = text.trim().replace(/\s+/g, " ");
    convo.title = clean.length > 42 ? clean.slice(0, 42) + "…" : clean || "New chat";
  }

  function renderHistory() {
    el.historyList.innerHTML = "";
    state.conversations.forEach((c) => {
      const item = document.createElement("div");
      item.className = "history-item" + (c.id === state.currentId ? " active" : "");
      item.textContent = c.title;
      item.addEventListener("click", () => {
        state.currentId = c.id;
        renderHistory();
        renderTranscript();
      });
      el.historyList.appendChild(item);
    });
  }

  /* ---------------------------------------------------------------------
     Rendering the transcript
     --------------------------------------------------------------------- */
  function renderTranscript() {
    const convo = getCurrentConversation();
    el.transcript.innerHTML = "";

    if (!convo || convo.messages.length === 0) {
      el.transcript.appendChild(el.emptyState);
      return;
    }

    convo.messages.forEach((msg) => appendMessageRow(msg));
    scrollToBottom();
  }

  function appendMessageRow(msg) {
    const row = document.createElement("div");
    row.className = "msg-row " + msg.role;
    row.dataset.msgId = msg.id;

    const avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    avatar.textContent = msg.role === "user" ? "YOU" : "OP";

    const body = document.createElement("div");
    body.className = "msg-body";

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.textContent = msg.role === "user" ? "You" : "Orion Pax";

    const content = document.createElement("div");
    content.className = "msg-content";

    if (msg.attachmentsMeta && msg.attachmentsMeta.length) {
      msg.attachmentsMeta.forEach((a) => {
        const chip = document.createElement("span");
        chip.className = "attachment-chip-inline";
        chip.textContent = "📎 " + a.name;
        content.appendChild(chip);
      });
      if (msg.attachmentsMeta.length) content.appendChild(document.createElement("br"));
    }

    const textSpan = document.createElement("span");
    textSpan.innerHTML = renderMarkdown(msg.text || "");
    content.appendChild(textSpan);

    body.appendChild(meta);
    body.appendChild(content);

    if (msg.role === "assistant" && msg.text) {
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", () => navigator.clipboard.writeText(msg.text));
      actions.appendChild(copyBtn);
      body.appendChild(actions);
    }

    row.appendChild(avatar);
    row.appendChild(body);
    el.transcript.appendChild(row);
    decorateCodeBlocks(content);
    return { row, content, textSpan };
  }

  function scrollToBottom() {
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  /* ---------------------------------------------------------------------
     Attachments
     --------------------------------------------------------------------- */
  const MAX_FILE_BYTES = 4.5 * 1024 * 1024;
  const TEXT_EXTENSIONS = [
    "txt", "md", "js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "h",
    "cs", "go", "rs", "rb", "php", "html", "css", "scss", "json", "yaml",
    "yml", "csv", "sql", "sh", "xml", "swift", "kt", "toml", "ini", "log",
  ];

  function fileKind(file) {
    if (file.type.startsWith("image/")) return "image";
    if (file.type === "application/pdf") return "file"; // sent inline, same as image
    const ext = file.name.split(".").pop().toLowerCase();
    if (TEXT_EXTENSIONS.includes(ext) || file.type.startsWith("text/")) return "text";
    return "unsupported";
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  async function handleFiles(fileList) {
    for (const file of Array.from(fileList)) {
      if (file.size > MAX_FILE_BYTES) {
        alert(`"${file.name}" is over 4.5 MB. Skipped — this app sends files inline with no server-side compression.`);
        continue;
      }
      const kind = fileKind(file);
      if (kind === "unsupported") {
        alert(`"${file.name}" isn't a supported type (image, PDF, or text/code file).`);
        continue;
      }
      if (kind === "text") {
        const text = await readFileAsText(file);
        state.pendingAttachments.push({ name: file.name, kind, text, size: file.size });
      } else {
        const dataUrl = await readFileAsDataUrl(file);
        const base64 = dataUrl.split(",")[1];
        state.pendingAttachments.push({
          name: file.name,
          kind,
          mediaType: file.type || "application/pdf",
          data: base64,
          size: file.size,
        });
      }
      renderAttachmentsBar();
    }
  }

  function renderAttachmentsBar() {
    el.attachmentsBar.innerHTML = "";
    state.pendingAttachments.forEach((att, idx) => {
      const chip = document.createElement("div");
      chip.className = "attachment-chip";
      const label = document.createElement("span");
      label.textContent = `📎 ${att.name}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "✕";
      remove.addEventListener("click", () => {
        state.pendingAttachments.splice(idx, 1);
        renderAttachmentsBar();
      });
      chip.appendChild(label);
      chip.appendChild(remove);
      el.attachmentsBar.appendChild(chip);
    });
  }

  /* ---------------------------------------------------------------------
     Building the Gemini "parts" payload
     --------------------------------------------------------------------- */
  function buildUserParts(promptText, attachments) {
    const parts = [];
    let combinedText = promptText;

    attachments.forEach((att) => {
      if (att.kind === "image" || att.kind === "file") {
        parts.push({ inlineData: { mimeType: att.mediaType, data: att.data } });
      } else if (att.kind === "text") {
        combinedText += `\n\n--- file: ${att.name} ---\n\`\`\`\n${att.text}\n\`\`\``;
      }
    });

    if (!combinedText.trim() && parts.length) {
      combinedText = "Please review the attached file(s).";
    }
    parts.push({ text: combinedText || "Hello." });
    return parts;
  }

  function conversationToApiContents(convo) {
    // Gemini uses role "model" for assistant turns, not "assistant".
    return convo.messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.apiParts && m.apiParts.length)
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: m.apiParts }));
  }

  /* ---------------------------------------------------------------------
     Streaming call to the Gemini API
     --------------------------------------------------------------------- */
  async function streamAssistantReply(assistantMsg, renderRefs, apiContents) {
    const { apiKey, systemPrompt, maxTokens, temperature } = state.settings;
    const model = activeModel();

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: apiContents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          maxOutputTokens: Number(maxTokens) || 4096,
          temperature: Number(temperature),
        },
      }),
    });

    if (!response.ok || !response.body) {
      let detail = "";
      try {
        const errJson = await response.json();
        detail = errJson?.error?.message || JSON.stringify(errJson);
      } catch {
        detail = `HTTP ${response.status}`;
      }
      throw new Error(detail);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let rafPending = false;
    let blockedReason = "";

    function flushToDom() {
      rafPending = false;
      renderRefs.textSpan.innerHTML = renderMarkdown(fullText) + '<span class="typing-cursor"></span>';
      decorateCodeBlocks(renderRefs.content);
      scrollToBottom();
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep last partial line in buffer

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr) continue;

        let event;
        try { event = JSON.parse(dataStr); } catch { continue; }

        if (event?.promptFeedback?.blockReason) {
          blockedReason = event.promptFeedback.blockReason;
        }

        const candidate = event?.candidates?.[0];
        const textPiece = (candidate?.content?.parts || [])
          .map((p) => p.text || "")
          .join("");
        if (textPiece) {
          fullText += textPiece;
          if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(flushToDom);
          }
        }
        if (candidate?.finishReason && candidate.finishReason !== "STOP" && !fullText) {
          blockedReason = blockedReason || candidate.finishReason;
        }
      }
    }

    if (!fullText && blockedReason) {
      throw new Error(`Response blocked or empty (reason: ${blockedReason}).`);
    }

    // final flush without the cursor
    renderRefs.textSpan.innerHTML = renderMarkdown(fullText);
    decorateCodeBlocks(renderRefs.content);
    assistantMsg.text = fullText;
    assistantMsg.apiParts = [{ text: fullText }];
  }

  /* ---------------------------------------------------------------------
     Status indicator
     --------------------------------------------------------------------- */
  function setStatus(mode, text) {
    el.statusDot.className = "status-dot" + (mode === "live" ? " live" : mode === "error" ? " error" : "");
    el.statusText.textContent = text;
    el.sparkCore.classList.toggle("thinking", mode === "live");
  }

  /* ---------------------------------------------------------------------
     Sending a message
     --------------------------------------------------------------------- */
  async function sendMessage() {
    const promptText = el.promptInput.value.trim();
    if (!promptText && state.pendingAttachments.length === 0) return;

    if (!state.settings.apiKey) {
      openSettings();
      setStatus("error", "Add your free Gemini API key to begin");
      return;
    }

    const convo = ensureConversation();
    setConversationTitleFromFirstMessage(convo, promptText || "Attachment");
    renderHistory();

    const attachments = state.pendingAttachments.slice();
    const userParts = buildUserParts(promptText, attachments);

    const userMsg = {
      id: crypto.randomUUID(),
      role: "user",
      text: promptText + (attachments.length ? `\n\n*${attachments.length} file(s) attached*` : ""),
      apiParts: userParts,
      attachmentsMeta: attachments.map((a) => ({ name: a.name })),
    };
    convo.messages.push(userMsg);

    // Reset composer
    el.promptInput.value = "";
    autosizeTextarea();
    state.pendingAttachments = [];
    renderAttachmentsBar();

    if (el.transcript.contains(el.emptyState)) el.transcript.removeChild(el.emptyState);
    appendMessageRow(userMsg);
    scrollToBottom();

    // Snapshot the API contents BEFORE pushing the empty assistant placeholder,
    // so the in-progress reply is never sent back to Gemini as an empty turn.
    const apiContents = conversationToApiContents(convo);

    const assistantMsg = { id: crypto.randomUUID(), role: "assistant", text: "", apiParts: [] };
    convo.messages.push(assistantMsg);
    const renderRefs = appendMessageRow(assistantMsg);
    renderRefs.textSpan.innerHTML = '<span class="typing-cursor"></span>';

    state.streaming = true;
    el.sendBtn.disabled = true;
    el.sendLabel.textContent = "…";
    setStatus("live", "Generating");

    try {
      await streamAssistantReply(assistantMsg, renderRefs, apiContents);
      setStatus("idle", "Idle");
    } catch (err) {
      console.error(err);
      renderRefs.textSpan.innerHTML =
        `<span style="color:var(--danger)">Request failed: ${escapeHtml(err.message || String(err))}</span>`;
      assistantMsg.text = "[error] " + (err.message || String(err));
      setStatus("error", "Error — see message");
    } finally {
      state.streaming = false;
      el.sendBtn.disabled = false;
      el.sendLabel.textContent = "SEND";
      persistConversations();
    }
  }

  /* ---------------------------------------------------------------------
     Settings modal
     --------------------------------------------------------------------- */
  function openSettings() {
    el.apiKeyInput.value = state.settings.apiKey;
    el.modelSelect.value = state.settings.model;
    el.customModelInput.value = state.settings.customModel || "";
    el.systemPromptInput.value = state.settings.systemPrompt;
    el.maxTokensInput.value = state.settings.maxTokens;
    el.temperatureInput.value = state.settings.temperature;
    el.settingsBackdrop.hidden = false;
  }

  function closeSettings() {
    el.settingsBackdrop.hidden = true;
  }

  function saveSettingsFromModal() {
    state.settings = {
      apiKey: el.apiKeyInput.value.trim(),
      model: el.modelSelect.value,
      customModel: el.customModelInput.value.trim(),
      systemPrompt: el.systemPromptInput.value,
      maxTokens: Number(el.maxTokensInput.value) || 4096,
      temperature: Number(el.temperatureInput.value),
    };
    saveSettings(state.settings);
    el.modelPill.textContent = modelLabel();
    closeSettings();
  }

  /* ---------------------------------------------------------------------
     Export / clear
     --------------------------------------------------------------------- */
  function exportConversation() {
    const convo = getCurrentConversation();
    if (!convo || convo.messages.length === 0) return;
    const md = convo.messages
      .map((m) => `### ${m.role === "user" ? "You" : "Orion Pax"}\n\n${m.text}\n`)
      .join("\n---\n\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${convo.title.replace(/[^\w\- ]/g, "").slice(0, 40) || "orion-pax-chat"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function clearCurrentConversation() {
    const convo = getCurrentConversation();
    if (!convo) return;
    if (!confirm("Clear this conversation? This can't be undone.")) return;
    state.conversations = state.conversations.filter((c) => c.id !== convo.id);
    state.currentId = null;
    persistConversations();
    renderHistory();
    renderTranscript();
  }

  /* ---------------------------------------------------------------------
     Textarea autosize + keyboard
     --------------------------------------------------------------------- */
  function autosizeTextarea() {
    el.promptInput.style.height = "auto";
    el.promptInput.style.height = Math.min(el.promptInput.scrollHeight, 200) + "px";
  }

  /* ---------------------------------------------------------------------
     Wire up events
     --------------------------------------------------------------------- */
  el.newChatBtn.addEventListener("click", createConversation);
  el.settingsBtn.addEventListener("click", openSettings);
  el.closeSettingsBtn.addEventListener("click", closeSettings);
  el.saveSettingsBtn.addEventListener("click", saveSettingsFromModal);
  el.settingsBackdrop.addEventListener("click", (e) => {
    if (e.target === el.settingsBackdrop) closeSettings();
  });
  el.exportBtn.addEventListener("click", exportConversation);
  el.clearBtn.addEventListener("click", clearCurrentConversation);

  el.attachBtn.addEventListener("click", () => el.fileInput.click());
  el.fileInput.addEventListener("change", (e) => {
    handleFiles(e.target.files);
    el.fileInput.value = "";
  });

  el.promptInput.addEventListener("input", autosizeTextarea);
  el.promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      el.composerForm.requestSubmit();
    }
  });

  el.composerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.streaming) return;
    sendMessage();
  });

  // Drag & drop attachments anywhere over the composer
  ["dragover", "drop"].forEach((evt) => {
    document.body.addEventListener(evt, (e) => e.preventDefault());
  });
  document.body.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });

  /* ---------------------------------------------------------------------
     Init
     --------------------------------------------------------------------- */
  function init() {
    el.modelPill.textContent = modelLabel();
    if (state.conversations.length) {
      state.currentId = state.conversations[0].id;
    }
    renderHistory();
    renderTranscript();
    if (!state.settings.apiKey) {
      setStatus("idle", "No API key set");
    } else {
      setStatus("idle", "Idle");
    }
  }

  init();
})();
