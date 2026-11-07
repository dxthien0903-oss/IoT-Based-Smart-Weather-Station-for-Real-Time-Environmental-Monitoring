// chatwidget.js — Floating AI Chat Widget logic
(function () {
  'use strict';

  const API_BASE = location.protocol === 'file:' ? 'http://localhost:3000' : location.origin;
  const fab = document.getElementById('chat-fab');
  const widget = document.getElementById('chat-widget');
  const closeBtn = document.getElementById('chat-widget-close');
  const messagesEl = document.getElementById('chat-messages');
  const inputEl = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  const quickActions = document.getElementById('chat-quick-actions');
  const fabIconChat = document.getElementById('fab-icon-chat');
  const fabIconClose = document.getElementById('fab-icon-close');

  let isOpen = false;
  let isWaiting = false;

  // Toggle chat widget
  function toggleChat() {
    isOpen = !isOpen;
    widget.classList.toggle('open', isOpen);
    widget.setAttribute('aria-hidden', String(!isOpen));
    fab.classList.toggle('active', isOpen);
    fabIconChat.classList.toggle('hidden', isOpen);
    fabIconClose.classList.toggle('hidden', !isOpen);
    if (isOpen) {
      inputEl.focus();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  fab.addEventListener('click', toggleChat);
  closeBtn.addEventListener('click', toggleChat);

  // Auto-resize textarea
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
  });

  // Send on Enter (Shift+Enter for newline)
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', () => sendMessage());

  // Quick action buttons
  quickActions.addEventListener('click', (e) => {
    const btn = e.target.closest('.chat-quick-btn');
    if (!btn) return;
    inputEl.value = btn.dataset.q;
    sendMessage();
  });

  function appendMessage(role, html) {
    const div = document.createElement('div');
    div.className = `chat-message ${role}`;
    const avatar = role === 'assistant' ? '🤖' : '👤';
    div.innerHTML = `
      <div class="chat-avatar">${avatar}</div>
      <div class="chat-bubble">${html}</div>
    `;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showTyping() {
    const div = document.createElement('div');
    div.className = 'chat-message assistant';
    div.id = 'typing-msg';
    div.innerHTML = `
      <div class="chat-avatar">🤖</div>
      <div class="chat-bubble">
        <div class="typing-indicator"><span></span><span></span><span></span></div>
      </div>
    `;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function removeTyping() {
    const t = document.getElementById('typing-msg');
    if (t) t.remove();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatResponse(text) {
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/^[•\-]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || isWaiting) return;

    quickActions.style.display = 'none';
    appendMessage('user', escapeHtml(text));
    inputEl.value = '';
    inputEl.style.height = 'auto';

    isWaiting = true;
    sendBtn.disabled = true;
    showTyping();

    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      });

      removeTyping();

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Lỗi kết nối server' }));
        appendMessage('assistant', `⚠️ ${escapeHtml(err.error || 'Đã xảy ra lỗi, vui lòng thử lại.')}`);
      } else {
        const data = await res.json();
        appendMessage('assistant', formatResponse(data.reply));
      }
    } catch (err) {
      removeTyping();
      appendMessage('assistant', '⚠️ Không thể kết nối server. Kiểm tra lại kết nối mạng.');
    } finally {
      isWaiting = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }
})();

