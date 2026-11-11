// chatwidget.js — Floating AI chat widget logic
(function () {
  'use strict';

  var API_BASE = location.protocol === 'file:' ? 'http://localhost:3000' : location.origin;

  var fab = document.getElementById('chat-fab');
  var widget = document.getElementById('chat-widget');
  var closeBtn = document.getElementById('chat-widget-close');
  var messagesEl = document.getElementById('chat-messages');
  var inputEl = document.getElementById('chat-input');
  var sendBtn = document.getElementById('chat-send-btn');
  var quickActions = document.getElementById('chat-quick-actions');
  var fabIconChat = document.getElementById('fab-icon-chat');
  var fabIconClose = document.getElementById('fab-icon-close');

  var isOpen = false;
  var isWaiting = false;

  var ASSISTANT_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="4" y="8" width="16" height="12" rx="3"/><circle cx="12" cy="3.5" r="1.2"/>' +
    '<path d="M9.5 13h.01M14.5 13h.01"/></svg>';

  var USER_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/></svg>';

  function toggleChat() {
    isOpen = !isOpen;
    widget.classList.toggle('open', isOpen);
    widget.setAttribute('aria-hidden', String(!isOpen));
    fab.classList.toggle('active', isOpen);
    fab.setAttribute('aria-expanded', String(isOpen));
    fabIconChat.classList.toggle('hidden', isOpen);
    fabIconClose.classList.toggle('hidden', !isOpen);
    if (isOpen) {
      inputEl.focus();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  fab.addEventListener('click', toggleChat);
  closeBtn.addEventListener('click', toggleChat);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) toggleChat();
  });

  // Auto-resize textarea
  inputEl.addEventListener('input', function () {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 96) + 'px';
  });

  // Enter sends, Shift+Enter newlines
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', function () { sendMessage(); });

  // Quick actions
  quickActions.addEventListener('click', function (e) {
    var btn = e.target.closest('.chat-quick-btn');
    if (!btn) return;
    inputEl.value = btn.dataset.q;
    sendMessage();
  });

  function appendMessage(role, html) {
    var div = document.createElement('div');
    div.className = 'chat-message ' + role;

    var avatar = document.createElement('div');
    avatar.className = 'chat-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.innerHTML = role === 'assistant' ? ASSISTANT_ICON : USER_ICON;

    var bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.innerHTML = html;

    div.appendChild(avatar);
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showTyping() {
    var div = document.createElement('div');
    div.className = 'chat-message assistant';
    div.id = 'typing-msg';

    var avatar = document.createElement('div');
    avatar.className = 'chat-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.innerHTML = ASSISTANT_ICON;

    var bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';

    div.appendChild(avatar);
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function removeTyping() {
    var t = document.getElementById('typing-msg');
    if (t) t.remove();
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Minimal, safe markdown: bold + bullet lists only. Input is escaped first.
  // Backend đã làm sạch **, nhưng frontend vẫn phòng hờ để không bao giờ hiện cụt kiểu "°C):**".
  function formatResponse(text) {
    var raw = String(text || '').replace(/\r/g, '');
    // Bỏ markdown còn sót từ AI
    raw = raw.replace(/\*\*(.*?)\*\*/g, '$1');
    raw = raw.replace(/__([^_]+)__/g, '$1');
    raw = raw.replace(/^#{1,6}\s+/gm, '');
    raw = raw.replace(/`/g, '');
    var html = escapeHtml(raw);
    html = html.replace(/^\*\s+(.+)$/gm, '- $1'); // "* câu" của AI -> "- câu"
    html = html.replace(/^[•\-]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, '<ul>$&</ul>');
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  function sendMessage() {
    var text = inputEl.value.trim();
    if (!text || isWaiting) return;

    quickActions.style.display = 'none';
    appendMessage('user', escapeHtml(text));
    inputEl.value = '';
    inputEl.style.height = 'auto';

    isWaiting = true;
    sendBtn.disabled = true;
    showTyping();

    fetch(API_BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    })
      .then(function (res) {
        removeTyping();
        if (!res.ok) {
          return res.json()
            .catch(function () { return { error: 'Lỗi kết nối server' }; })
            .then(function (err) {
              appendMessage('assistant', escapeHtml(err.error || 'Đã xảy ra lỗi, vui lòng thử lại.'));
            });
        }
        return res.json().then(function (data) {
          appendMessage('assistant', formatResponse(data.reply || ''));
        });
      })
      .catch(function () {
        removeTyping();
        appendMessage('assistant', 'Không thể kết nối server. Kiểm tra lại kết nối mạng.');
      })
      .then(function () {
        isWaiting = false;
        sendBtn.disabled = false;
        inputEl.focus();
      });
  }
})();
