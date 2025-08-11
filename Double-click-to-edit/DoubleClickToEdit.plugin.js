/**
 * @name MessageClickActions
 * @author Modified by Seilesh
 * @version 1.0.0
 * @description Adds simple click actions to messages: Backspace + Click = Delete, Double-click your message = Edit, Double-click someone else's = Reply.
 * @source Based on DoubleClickToEdit by Farcrada
 */

const { Webpack, Filters, ReactUtils, Utils } = BdApi;

const walkable = ["child", "memoizedProps", "sibling"];

module.exports = class MessageClickActions {
    start() {
        // Get needed modules
        this.MessageStore = Webpack.getModule(Filters.byKeys("receiveMessage", "editMessage"));
        this.CurrentUserStore = Webpack.getModule(Filters.byKeys("getCurrentUser"));
        this.getChannel = Webpack.getModule(Filters.byKeys("getChannel", "getDMFromUserId")).getChannel;
        this.replyToMessage = Webpack.getModule(m => m?.toString?.()?.includes("shouldMention:!"), { searchExports: true });
        this.deleteMessage = Webpack.getModule(Filters.byKeys("deleteMessage")).deleteMessage;

        document.addEventListener("click", this.clickHandler);
        document.addEventListener("dblclick", this.doubleClickHandler);
    }

    stop() {
        document.removeEventListener("click", this.clickHandler);
        document.removeEventListener("dblclick", this.doubleClickHandler);
    }

    clickHandler = (e) => {
        // Backspace + Click → Delete message
        if (!e.target) return;
        if (e.target.closest('textarea, input')) return; // Ignore typing areas
        if (!this.isBackspaceHeld(e)) return;

        const messageData = this.getMessageDataFromEvent(e);
        if (!messageData) return;

        // Only allow deleting own messages
        if (messageData.author.id === this.CurrentUserStore.getCurrentUser().id) {
            this.deleteMessage(messageData.channel_id, messageData.id);
        }
    };

    doubleClickHandler = (e) => {
        const messageData = this.getMessageDataFromEvent(e);
        if (!messageData) return;

        if (messageData.author.id === this.CurrentUserStore.getCurrentUser().id) {
            // Edit your own message
            this.MessageStore.startEditMessage(messageData.channel_id, messageData.id, messageData.content);
        } else {
            // Reply to someone else
            this.replyToMessage(this.getChannel(messageData.channel_id), messageData, e);
        }
    };

    isBackspaceHeld(e) {
        // Detect if Backspace is pressed — unfortunately click events don't track key states directly
        // So we need a workaround: listen to keydown/up and store state
        return this.backspaceDown;
    }

    getMessageDataFromEvent(e) {
        const messageDiv = e.target.closest('li > [class^=message]');
        if (!messageDiv) return null;

        const instance = ReactUtils.getInternalInstance(messageDiv);
        if (!instance) return null;

        return Utils.findInTree(instance, m => m?.baseMessage, { walkable })?.baseMessage ??
               Utils.findInTree(instance, m => m?.message, { walkable })?.message;
    }

    constructor() {
        // Track Backspace key state
        this.backspaceDown = false;
        document.addEventListener("keydown", (ev) => {
            if (ev.key === "Backspace") this.backspaceDown = true;
        });
        document.addEventListener("keyup", (ev) => {
            if (ev.key === "Backspace") this.backspaceDown = false;
        });
    }
};
