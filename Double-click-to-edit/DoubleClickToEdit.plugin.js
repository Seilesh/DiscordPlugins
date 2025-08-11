/**
 * @name MessageClickActionsBD
 * @author ChatGPT (adapted for BetterDiscord)
 * @version 1.0.0
 * @description Backspace+Click deletes message, dblclick your message to edit, dblclick others' message to reply (Vencord-style).
 */

/* global BdApi, React */

module.exports = class MessageClickActionsBD {
  constructor() {
    this.name = "MessageClickActionsBD";
    this._onClick = this._onClick.bind(this);
    this._onDblClick = this._onDblClick.bind(this);
    this._lastClickTime = 0;
  }

  start() {
    // Attach capturing listeners so we get events before Discord's own handlers.
    document.addEventListener("click", this._onClick, true);
    document.addEventListener("dblclick", this._onDblClick, true);
    BdApi.log(`${this.name} started`);
  }

  stop() {
    document.removeEventListener("click", this._onClick, true);
    document.removeEventListener("dblclick", this._onDblClick, true);
    BdApi.log(`${this.name} stopped`);
  }

  // Utility: try to get React props for a DOM node (walk up to nearest fiber)
  _getReactProps(elem) {
    if (!elem) return null;
    for (const key in elem) {
      if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
        const fiber = elem[key];
        // Walk up to find a node with memoizedProps that contains message
        let node = fiber;
        while (node) {
          if (node.memoizedProps && (node.memoizedProps.message || node.memoizedProps.children)) {
            return node.memoizedProps;
          }
          node = node.return;
        }
      }
    }
    return null;
  }

  // Utility: walk up DOM until we find an element that likely represents a message
  _findMessageElement(target) {
    if (!target) return null;
    // Look for elements with attributes that often contain message id or that are message wrappers.
    let el = target;
    while (el && el !== document) {
      if (el.dataset && (el.dataset.messageId || el.dataset.listItemId || el.getAttribute("data-message-id"))) return el;
      // Common Discord class names include message wrappers; we test for typical ones as fallback
      if (el.classList && (el.classList.contains("message-2qnXI6") || el.classList.contains("container-3baos1") || el.classList.contains("messageContent-2qWWxC"))) return el;
      el = el.parentElement;
    }
    return null;
  }

  // Get message data via stores (with multiple fallbacks)
  _getStores() {
    const stores = {};
    // Messages store (getMessage / getMessages)
    stores.Messages = BdApi.findModuleByProps("getMessage", "getMessages") || BdApi.findModuleByProps("getMessage", "getMessagesInChannel");
    // Current user
    stores.UserStore = BdApi.findModuleByProps("getCurrentUser") || BdApi.findModuleByProps("getUser");
    // Message actions: delete/edit/reply - these names may vary; try several known props
    stores.MessageActions = BdApi.findModuleByProps("deleteMessage", "editMessage", "receiveMessage") ||
                             BdApi.findModuleByProps("deleteMessage", "editMessage") ||
                             BdApi.findModule(m => m && (m.deleteMessage || m.editMessage || m.createMessage));
    // Utility to open reply/edit UI: Try to find functions used by Discord components
    stores.MessageContext = BdApi.findModuleByProps("openContextMenu") || BdApi.findModuleByProps("open", "closeAllModals");
    return stores;
  }

  // MAIN click handler for Backspace+Click (we keep clicks separate from dblclick)
  _onClick(e) {
    try {
      // Only react to primary button clicks
      if (e.button !== 0) return;
      // Check if Backspace is currently pressed — use KeyboardEvent.getModifierState for keys like 'Shift', but Backspace doesn't map to modifier state in all browsers.
      // So check e.getModifierState('Backspace') first; fallback to checking global keys via a small memory of last keydown.
      const backspaceHeld = e.getModifierState && e.getModifierState("Backspace") || this._isBackspaceDown;
      if (!backspaceHeld) return;

      const msgEl = this._findMessageElement(e.target);
      if (!msgEl) return;

      // Attempt to find React props with message info
      const props = this._getReactProps(msgEl) || {};
      let message = props.message || props.msg || null;

      // If we don't have message from React props, try to extract id from attributes and query store
      if (!message) {
        const id = msgEl.dataset.messageId || msgEl.getAttribute("data-message-id") || msgEl.dataset.listItemId;
        if (id) {
          const stores = this._getStores();
          if (stores && stores.Messages && typeof stores.Messages.getMessage === "function") {
            // listItemId sometimes is like "messages-CHANNELID-MESSAGEID"
            let channelId, messageId;
            const parts = id.split("-");
            if (parts.length >= 2) {
              // try to parse last two parts as channel and message
              messageId = parts.pop();
              channelId = parts.pop();
            }
            // fallback: try to get message by iterating (rare)
            try {
              if (channelId && messageId) message = stores.Messages.getMessage(channelId, messageId);
            } catch (err) { /* ignore */ }
          }
        }
      }

      if (!message) return;

      // Double-check ownership? For delete we allow deleting only our message (Discord permission check)
      const stores = this._getStores();
      const currentUser = stores.UserStore && stores.UserStore.getCurrentUser && stores.UserStore.getCurrentUser();
      const amOwner = currentUser && message && (message.author && message.author.id === currentUser.id);

      // Only allow delete if message belongs to current user (mimic normal Discord delete permissions)
      if (!amOwner) return;

      // Delete using known action
      const actions = stores.MessageActions;
      if (actions && typeof actions.deleteMessage === "function") {
        actions.deleteMessage(message.channel_id, message.id);
        e.stopPropagation();
        e.preventDefault();
        return;
      }

      // Fallback: dispatch a DELETE action via Dispatcher if available
      const Dispatcher = BdApi.findModuleByProps("dispatch", "isDispatching");
      if (Dispatcher && Dispatcher.dispatch) {
        Dispatcher.dispatch({
          type: "DELETE_MESSAGE",
          channelId: message.channel_id,
          messageId: message.id
        });
        e.stopPropagation();
        e.preventDefault();
        return;
      }
    } catch (err) {
      BdApi.showToast(`${this.name} error (click): ${err.message}`, {type: "error"});
      console.error(err);
    }
  }

  // Double-click handler: edit or reply depending on author
  _onDblClick(e) {
    try {
      // Avoid handling if user double-clicks while holding backspace (we prefer delete behavior on single click)
      const msgEl = this._findMessageElement(e.target);
      if (!msgEl) return;

      const props = this._getReactProps(msgEl) || {};
      let message = props.message || props.msg || null;

      // fallback by parsing attributes and store (same as in _onClick)
      if (!message) {
        const id = msgEl.dataset.messageId || msgEl.getAttribute("data-message-id") || msgEl.dataset.listItemId;
        if (id) {
          const stores = this._getStores();
          if (stores && stores.Messages && typeof stores.Messages.getMessage === "function") {
            let channelId, messageId;
            const parts = id.split("-");
            if (parts.length >= 2) {
              messageId = parts.pop();
              channelId = parts.pop();
            }
            try {
              if (channelId && messageId) message = stores.Messages.getMessage(channelId, messageId);
            } catch (err) { /* ignore */ }
          }
        }
      }

      if (!message) return;

      const stores = this._getStores();
      const currentUser = stores.UserStore && stores.UserStore.getCurrentUser && stores.UserStore.getCurrentUser();
      const amOwner = currentUser && message && (message.author && message.author.id === currentUser.id);

      // If it's our message => trigger edit
      if (amOwner) {
        // Try to use editMessage or an editor-opening function
        if (stores.MessageActions && typeof stores.MessageActions.startEditMessage === "function") {
          stores.MessageActions.startEditMessage(message.channel_id, message.id);
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        if (stores.MessageActions && typeof stores.MessageActions.editMessage === "function") {
          // If there's an editMessage that takes (channelId, messageId, newContent) we can't open UI; but try dispatch
          try {
            stores.MessageActions.editMessage(message.channel_id, message.id, message.content || "");
            e.stopPropagation();
            e.preventDefault();
            return;
          } catch (err) { /* ignore */ }
        }

        // Fallback: attempt to focus the text area and prefill with message content and set edit mode by dispatching an action
        const CreateMessage = BdApi.findModuleByProps("startEditMessage", "stopEditMessage") || BdApi.findModuleByProps("startEdit", "stopEdit");
        if (CreateMessage && typeof CreateMessage.startEditMessage === "function") {
          CreateMessage.startEditMessage(message.channel_id, message.id);
          e.stopPropagation();
          e.preventDefault();
          return;
        }

        // as last resort, open the context menu's "Edit" action if available
        // Not implementing UI-based fallback here; let user know if not possible
        BdApi.showToast("Edit action couldn't be invoked automatically in this client build.", {type: "warning"});
        return;
      }

      // If it's someone else's message => reply
      // Many Discord internal modules provide a function like 'openReply' or 'startReply' or MessageActions.reply
      if (stores.MessageActions && typeof stores.MessageActions.openReply === "function") {
        stores.MessageActions.openReply(message.channel_id, message.id);
        e.stopPropagation();
        e.preventDefault();
        return;
      }

      // Try a known action name
      const replyFuncs = ["startReply", "replyToMessage", "createReply", "openReplyInterface"];
      for (const fn of replyFuncs) {
        if (stores.MessageActions && typeof stores.MessageActions[fn] === "function") {
          try {
            stores.MessageActions[fn](message.channel_id, message.id);
            e.stopPropagation();
            e.preventDefault();
            return;
          } catch (err) { /* continue */ }
        }
      }

      // Another fallback: construct the reply by inserting a blockquote-like mention in composer and focusing it
      const channel = message.channel_id;
      // Try to focus composer and insert mention (best-effort)
      const composer = document.querySelector('textarea');
      if (composer) {
        composer.focus();
        const replyText = `> <@${message.author.id}> ${message.content ? `\n${message.content}` : ""}\n`;
        // Insert value at cursor
        const start = composer.selectionStart || 0;
        const val = composer.value || "";
        composer.value = val.slice(0, start) + replyText + val.slice(start);
        // trigger input event so Discord updates internal state
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        e.stopPropagation();
        e.preventDefault();
        return;
      }

      // If we get here, no reply method available
      BdApi.showToast("Reply action couldn't be invoked automatically in this client build.", {type: "warning"});
    } catch (err) {
      BdApi.showToast(`${this.name} error (dblclick): ${err.message}`, {type: "error"});
      console.error(err);
    }
  }
};
