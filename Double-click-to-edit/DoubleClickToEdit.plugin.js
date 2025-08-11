/**
 * @name MessageClickActions
 * @author You
 * @version 1.0.0
 * @description Hold Backspace + click to delete, double-click to edit/reply (BetterDiscord port).
 */

const PLUGIN_NAME = "MessageClickActions";

module.exports = class MessageClickActions {
  constructor() {
    this.defaultSettings = {
      enableDeleteOnClick: true,
      enableDoubleClickToEdit: true,
      enableDoubleClickToReply: true,
      requireModifier: false, // require ctrl/shift for double-click actions
    };

    // state
    this.settings = BdApi.Data.load(PLUGIN_NAME, "settings") || this.defaultSettings;
    this.isDeletePressed = false;
    this._patched = false;
  }

  start() {
    // Keep simple: load settings (persisted)
    this.settings = BdApi.Data.load(PLUGIN_NAME, "settings") || this.defaultSettings;

    // key listeners for Backspace hold
    this._keydown = (e) => { if (e.key === "Backspace") this.isDeletePressed = true; };
    this._keyup   = (e) => { if (e.key === "Backspace") this.isDeletePressed = false; };
    document.addEventListener("keydown", this._keydown);
    document.addEventListener("keyup", this._keyup);

    // find modules/stores/actions we need (best-effort with fallbacks)
    const Webpack = BdApi.Webpack;
    this.MessageActions = Webpack.getModule(m => m?.deleteMessage && m?.startEditMessage) || Webpack.getModule(m => m?.deleteMessage && m?.editMessage);
    this.FluxDispatcher = Webpack.getModule(m => m?.dispatch && m?.subscribe && m?.unsubscribe) || Webpack.getModule(m => m?.dispatch && m?._dispatchToken);
    this.ChannelStore = Webpack.getStore ? Webpack.getStore("ChannelStore") : Webpack.getModule(m => m?.getChannel && m?.getDMFromUserId);
    this.UserStore = Webpack.getStore ? Webpack.getStore("UserStore") : Webpack.getModule(m => m?.getCurrentUser);
    this.EditStore = Webpack.getModule(m => m?.isEditing && m?.isEditingAny) || {};
    this.PermissionStore = Webpack.getStore ? Webpack.getStore("PermissionStore") : Webpack.getModule(m => m?.can && m?.isSomething);
    this.PermissionsBits = Webpack.getModule(m => m?.ADMINISTRATOR && m?.SEND_MESSAGES) || {};

    // find the Message React component (this can vary; try common patterns)
    const MessageModule = Webpack.getModule(m => m?.default?.displayName === "Message" || (m?.default && m.default.displayName && m.default.displayName.includes("Message")));

    if (!MessageModule) {
      console.warn(PLUGIN_NAME, "Couldn't find Message component — plugin may be incompatible with this client version.");
      return;
    }

    // Patch the Message component so we get the message & channel for click events.
    // We'll clone the returned React element and inject our onClick wrapper.
    BdApi.Patcher.after(PLUGIN_NAME, MessageModule, "default", (thisObj, args, returnValue) => {
      try {
        const props = args && args[0] ? args[0] : {};
        const msg = props.message ?? (props.msg ?? null);
        if (!msg) return returnValue; // nothing to do

        // compute channel object robustly
        const channel = (msg && msg.channel_id)
          ? (this.ChannelStore && this.ChannelStore.getChannel ? this.ChannelStore.getChannel(msg.channel_id) : null)
          : (props.channel ?? null);

        const oldOnClick = (returnValue && returnValue.props && returnValue.props.onClick) ? returnValue.props.onClick : null;

        const myOnClick = (event) => {
          try { if (typeof oldOnClick === "function") oldOnClick(event); } catch (err) { console.error(err); }

          // basic guards
          const isMe = msg?.author?.id === (this.UserStore?.getCurrentUser?.()?.id ?? (this.UserStore?.getCurrentUser && this.UserStore.getCurrentUser().id));
          // If backspace is NOT pressed -> handle double-click actions
          if (!this.isDeletePressed) {
            // need at least double click
            if (event.detail < 2) return;
            if (this.settings.requireModifier && !event.ctrlKey && !event.shiftKey) return;
            if (msg.deleted === true) return;

            // If message is ours -> edit
            if (isMe) {
              if (!this.settings.enableDoubleClickToEdit) return;
              if (this.EditStore && typeof this.EditStore.isEditing === "function" && this.EditStore.isEditing(channel?.id, msg.id)) return;
              if (this.MessageActions && typeof this.MessageActions.startEditMessage === "function") {
                try { this.MessageActions.startEditMessage(channel?.id ?? msg.channel_id, msg.id, msg.content); } catch(e){console.error(e);}
                event.preventDefault();
              }
            } else {
              // reply to others
              if (!this.settings.enableDoubleClickToReply) return;
              // skip ephemeral messages (Vencord checks a flag). best-effort:
              const EPHEMERAL = 64;
              if (typeof msg.hasFlag === "function" && msg.hasFlag(EPHEMERAL)) return;

              if (this.FluxDispatcher && typeof this.FluxDispatcher.dispatch === "function") {
                try {
                  this.FluxDispatcher.dispatch({
                    type: "CREATE_PENDING_REPLY",
                    channel,
                    message: msg,
                    shouldMention: true,
                    showMentionToggle: channel?.guild_id != null
                  });
                } catch (err) { console.error(err); }
              }
            }
          } else {
            // Backspace is held => delete behavior
            if (!this.settings.enableDeleteOnClick) return;
            // only allow delete if it's our message OR we have manage messages permission
            const isAllowedToDelete = isMe || (this.PermissionStore && typeof this.PermissionStore.can === "function" && this.PermissionStore.can(this.PermissionsBits?.MANAGE_MESSAGES ?? "MANAGE_MESSAGES", channel));
            if (!isAllowedToDelete) return;

            if (msg.deleted) {
              // if already deleted, dispatch message-delete event (best-effort)
              if (this.FluxDispatcher && typeof this.FluxDispatcher.dispatch === "function") {
                try {
                  this.FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", channelId: channel?.id ?? msg.channel_id, id: msg.id, mlDeleted: true });
                } catch (err) { console.error(err); }
              }
            } else {
              if (this.MessageActions && typeof this.MessageActions.deleteMessage === "function") {
                try { this.MessageActions.deleteMessage(channel?.id ?? msg.channel_id, msg.id); } catch(e){console.error(e);}
              }
            }
            event.preventDefault();
          }
        };

        // clone the returned tree and add our onClick (merge with existing props)
        const React = BdApi.React;
        return React.cloneElement(returnValue, Object.assign({}, returnValue.props, { onClick: myOnClick }));
      } catch (err) {
        console.error(PLUGIN_NAME, "patch error", err);
        return returnValue;
      }
    });

    this._patched = true;
    console.log(PLUGIN_NAME, "started");
  }

  stop() {
    // remove listeners and patches
    document.removeEventListener("keydown", this._keydown);
    document.removeEventListener("keyup", this._keyup);
    BdApi.Patcher.unpatchAll(PLUGIN_NAME);
    this._patched = false;
    console.log(PLUGIN_NAME, "stopped");
  }

  getSettingsPanel() {
    const panel = document.createElement("div");
    panel.style.padding = "8px";

    const makeCheckbox = (label, key) => {
      const line = document.createElement("div");
      line.style.marginBottom = "8px";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = this.settings[key];
      cb.onchange = () => {
        this.settings[key] = cb.checked;
        BdApi.Data.save(PLUGIN_NAME, "settings", this.settings);
      };
      const lbl = document.createElement("label");
      lbl.style.marginLeft = "8px";
      lbl.textContent = label;
      line.appendChild(cb);
      line.appendChild(lbl);
      return line;
    };

    panel.appendChild(makeCheckbox("Enable delete on click (hold Backspace + click)", "enableDeleteOnClick"));
    panel.appendChild(makeCheckbox("Double-click to edit (your messages)", "enableDoubleClickToEdit"));
    panel.appendChild(makeCheckbox("Double-click to reply (others' messages)", "enableDoubleClickToReply"));
    panel.appendChild(makeCheckbox("Require Ctrl/Shift key for double-click actions", "requireModifier"));

    return panel;
  }
};
