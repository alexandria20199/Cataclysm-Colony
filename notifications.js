(() => {
    "use strict";

    const accountArea = document.querySelector("#headerAccount, #accountArea, .header-account");
    if (!accountArea) return;

    const request = async (url, options = {}) => {
        const response = await fetch(url, { credentials: "same-origin", ...options });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Request failed.");
        return data;
    };

    function addControl(id, tagName, className, label, href) {
        if (document.getElementById(id)) return document.getElementById(id);
        const control = document.createElement(tagName);
        control.id = id;
        control.className = className;
        control.setAttribute("aria-label", label);
        control.title = label;
        if (href) control.href = href;
        control.textContent = label;
        accountArea.prepend(control);
        return control;
    }

    function renderSettingsButton() {
        const control = addControl("headerSettingsButton", "a", "header-settings", "⚙", "settings.html");
        control.setAttribute("aria-label", "Settings");
        control.title = "Settings";
    }

    function renderStaffHeader() {
        const chat = addControl("headerStaffChatButton", "button", "header-staff-chat", "☏", null);
        chat.type = "button";
        chat.innerHTML = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-5.5a7.5 7.5 0 1 1 17-4Z\"/><path d=\"M7.5 10h9M7.5 14h6\"/></svg>";
        chat.setAttribute("aria-label", "Staff chat");
        chat.title = "Staff chat";
        if (chat.dataset.ready !== "true") {
            chat.addEventListener("click", openChat);
            chat.dataset.ready = "true";
        }
        const admin = addControl("headerAdminDeskLink", "a", "header-admin-desk", "▦ Admin Desk", "admin.html");
        admin.textContent = "▦ Admin Desk";
    }

    function renderNotifications(items, unread) {
        if (document.getElementById("notificationCenter")) return;
        const center = document.createElement("div");
        center.id = "notificationCenter";
        center.className = "notification-center";
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "notification-trigger";
        trigger.setAttribute("aria-expanded", "false");
        trigger.textContent = `Alerts${unread ? ` (${unread > 9 ? "9+" : unread})` : ""}`;
        const panel = document.createElement("section");
        panel.className = "notification-panel";
        panel.hidden = true;
        const heading = document.createElement("div");
        heading.className = "notification-panel-heading";
        const title = document.createElement("strong");
        title.textContent = "NEWSROOM ALERTS";
        heading.append(title);
        if (unread) {
            const read = document.createElement("button");
            read.type = "button";
            read.className = "notification-read-button";
            read.textContent = "Mark all read";
            read.addEventListener("click", async () => {
                try { await request("/api/notifications/read", { method: "POST" }); center.remove(); loadNotifications(); }
                catch (error) { showNotice(error.message); }
            });
            heading.append(read);
        }
        const list = document.createElement("div");
        list.className = "notification-list";
        if (!items.length) {
            const empty = document.createElement("div");
            empty.className = "notification-empty";
            empty.textContent = "No alerts yet.";
            list.append(empty);
        }
        for (const item of items) {
            const link = document.createElement("a");
            link.className = `notification-item ${item.is_read ? "" : "unread"}`;
            try {
                const target = new URL(typeof item.link === "string" ? item.link : "#", window.location.href);
                link.href = target.origin === window.location.origin ? target.href : "#";
            } catch { link.href = "#"; }
            const type = document.createElement("span");
            type.className = "notification-type";
            type.textContent = item.type || "update";
            const name = document.createElement("strong");
            name.textContent = item.title || "Update";
            const message = document.createElement("p");
            message.textContent = item.message || "";
            const date = document.createElement("small");
            date.textContent = new Date(item.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
            link.append(type, name, message, date);
            if (typeof item.image_url === "string" && item.image_url.startsWith("https://")) {
                const image = document.createElement("img");
                image.className = "notification-image";
                image.src = item.image_url;
                image.alt = "";
                image.loading = "lazy";
                link.prepend(image);
            }
            list.append(link);
        }
        panel.append(heading, list);
        center.append(trigger, panel);
        accountArea.prepend(center);
        trigger.addEventListener("click", () => {
            panel.hidden = !panel.hidden;
            trigger.setAttribute("aria-expanded", String(!panel.hidden));
        });
        document.addEventListener("click", event => {
            if (!center.contains(event.target) && !panel.hidden) {
                panel.hidden = true;
                trigger.setAttribute("aria-expanded", "false");
            }
        });
    }

    async function loadNotifications() {
        try {
            const data = await request("/api/notifications");
            renderNotifications(data.notifications || [], data.unread || 0);
        } catch { /* Guests have no private notifications. */ }
    }

    let drawer;
    let conversations = [];
    let activeId = null;
    let polling = null;
    let people = [];
    let noticeTimer;

    function showNotice(message) {
        const notice = drawer?.querySelector(".staff-chat-notice");
        if (!notice) return;
        notice.textContent = message;
        notice.hidden = false;
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => { notice.hidden = true; }, 4500);
    }

    function buildChatDrawer() {
        if (drawer) return drawer;
        drawer = document.createElement("div");
        drawer.className = "staff-chat-backdrop";
        drawer.id = "staffChatBackdrop";
        drawer.hidden = true;
        drawer.innerHTML = `
            <aside class="staff-chat-drawer" role="dialog" aria-modal="true" aria-label="Staff chat">
                <header class="staff-chat-topbar"><div><span class="staff-chat-eyebrow">PRIVATE STAFF MESSAGING</span><h2>Messages</h2></div><button class="staff-chat-close" type="button" aria-label="Close chat">×</button></header>
                <p class="staff-chat-notice" role="status" hidden></p>
                <div class="staff-chat-layout">
                    <section class="staff-chat-sidebar" aria-label="Conversations"><button class="staff-chat-new" type="button">＋ New chat</button><div class="staff-chat-conversations"></div></section>
                    <section class="staff-chat-main">
                        <div class="staff-chat-empty"><span>✉</span><strong>Your newsroom, in one place</strong><p>Choose a conversation or start a new one.</p></div>
                        <section class="staff-chat-thread" hidden><header class="staff-chat-thread-header"><strong></strong><small></small></header><div class="staff-chat-messages" role="log" aria-live="polite"></div><form class="staff-chat-compose"><textarea maxlength="2000" rows="2" placeholder="Write a message…" aria-label="Write a message" required></textarea><button type="submit" aria-label="Send message">Send</button></form></section>
                        <section class="staff-chat-new-view" hidden><header class="staff-chat-thread-header"><strong>Start a conversation</strong><small>Select one colleague for a private chat, or several to create a group.</small></header><form class="staff-chat-new-form"><label class="staff-chat-group-label">Group name <input name="title" maxlength="60" placeholder="Add a name for a group"></label><div class="staff-chat-people"></div><button class="staff-chat-create" type="submit">Create chat</button></form></section>
                    </section>
                </div>
            </aside>`;
        document.body.append(drawer);
        drawer.addEventListener("click", event => { if (event.target === drawer) closeChat(); });
        drawer.querySelector(".staff-chat-close").addEventListener("click", closeChat);
        drawer.querySelector(".staff-chat-new").addEventListener("click", showNewChat);
        drawer.querySelector(".staff-chat-compose").addEventListener("submit", sendMessage);
        drawer.querySelector(".staff-chat-new-form").addEventListener("submit", createConversation);
        document.addEventListener("keydown", event => { if (event.key === "Escape" && !drawer.hidden) closeChat(); });
        return drawer;
    }

    async function openChat() {
        const ui = buildChatDrawer();
        ui.hidden = false;
        document.body.classList.add("staff-chat-open");
        await loadConversations();
        if (activeId) await selectConversation(activeId);
        if (polling) clearInterval(polling);
        polling = setInterval(async () => {
            if (drawer.hidden) return;
            await loadConversations();
            if (activeId) await loadMessages(activeId, false);
        }, 6000);
    }

    function closeChat() {
        if (drawer) drawer.hidden = true;
        document.body.classList.remove("staff-chat-open");
        if (polling) clearInterval(polling);
        polling = null;
    }

    function renderConversations() {
        const list = drawer.querySelector(".staff-chat-conversations");
        list.replaceChildren();
        if (!conversations.length) {
            const empty = document.createElement("p");
            empty.className = "staff-chat-list-empty";
            empty.textContent = "No conversations yet";
            list.append(empty);
        }
        for (const conversation of conversations) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = `staff-chat-conversation ${String(conversation.id) === String(activeId) ? "selected" : ""}`;
            const avatar = document.createElement("span");
            avatar.className = "staff-chat-avatar";
            avatar.textContent = conversation.is_group ? "✦" : String(conversation.title || "?").slice(0, 1).toUpperCase();
            const info = document.createElement("span");
            info.className = "staff-chat-conversation-info";
            const title = document.createElement("strong");
            title.textContent = conversation.title || "Staff chat";
            const preview = document.createElement("small");
            preview.textContent = conversation.last_sender ? `${conversation.last_sender}: ${conversation.preview}` : (conversation.preview || "Start the conversation");
            info.append(title, preview);
            button.append(avatar, info);
            button.addEventListener("click", () => selectConversation(conversation.id));
            list.append(button);
        }
    }

    async function loadConversations() {
        try {
            const data = await request("/api/staff/chat/conversations");
            conversations = data.conversations || [];
            renderConversations();
        } catch (error) { showNotice(error.message); }
    }

    async function selectConversation(id) {
        activeId = id;
        const conversation = conversations.find(item => String(item.id) === String(id));
        if (!conversation) return;
        renderConversations();
        drawer.querySelector(".staff-chat-empty").hidden = true;
        drawer.querySelector(".staff-chat-new-view").hidden = true;
        drawer.querySelector(".staff-chat-thread").hidden = false;
        drawer.querySelector(".staff-chat-thread-header strong").textContent = conversation.title || "Staff chat";
        drawer.querySelector(".staff-chat-thread-header small").textContent = conversation.is_group ? `Group · ${conversation.participants}` : "Private staff conversation";
        await loadMessages(id, true);
    }

    async function loadMessages(id, scrollToBottom) {
        try {
            const data = await request(`/api/staff/chat/conversations/${encodeURIComponent(id)}/messages`);
            const list = drawer.querySelector(".staff-chat-messages");
            list.replaceChildren();
            for (const item of data.messages || []) {
                const row = document.createElement("article");
                row.className = `staff-chat-message ${item.username === window.CataclysmCurrentUser?.username ? "mine" : ""}`;
                const bubble = document.createElement("div");
                bubble.className = "staff-chat-bubble";
                if (item.username !== window.CataclysmCurrentUser?.username) {
                    const sender = document.createElement("strong");
                    sender.textContent = item.username;
                    bubble.append(sender);
                }
                const text = document.createElement("p");
                text.textContent = item.message;
                const time = document.createElement("small");
                time.textContent = new Date(item.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                bubble.append(text, time);
                row.append(bubble);
                list.append(row);
            }
            if (scrollToBottom) list.scrollTop = list.scrollHeight;
        } catch (error) { showNotice(error.message); }
    }

    async function sendMessage(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const input = form.querySelector("textarea");
        const button = form.querySelector("button");
        if (!activeId || !input.value.trim()) return;
        button.disabled = true;
        try {
            await request(`/api/staff/chat/conversations/${encodeURIComponent(activeId)}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: input.value.trim() }) });
            input.value = "";
            await loadMessages(activeId, true);
            await loadConversations();
        } catch (error) { showNotice(error.message); }
        finally { button.disabled = false; input.focus(); }
    }

    async function showNewChat() {
        drawer.querySelector(".staff-chat-empty").hidden = true;
        drawer.querySelector(".staff-chat-thread").hidden = true;
        const view = drawer.querySelector(".staff-chat-new-view");
        view.hidden = false;
        try {
            const data = await request("/api/staff/chat/people");
            people = data.people || [];
            const list = view.querySelector(".staff-chat-people");
            list.replaceChildren();
            if (!people.length) {
                const empty = document.createElement("p");
                empty.textContent = "No other Admins or Owner accounts are available yet.";
                list.append(empty);
            }
            for (const person of people) {
                const label = document.createElement("label");
                label.className = "staff-chat-person";
                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.value = person.id;
                const name = document.createElement("span");
                name.textContent = person.username;
                const role = document.createElement("small");
                role.textContent = person.role === "owner" ? "Owner" : "Admin";
                label.append(checkbox, name, role);
                list.append(label);
            }
        } catch (error) { showNotice(error.message); }
    }

    async function createConversation(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const memberIds = [...form.querySelectorAll("input[type=checkbox]:checked")].map(input => Number(input.value));
        const title = form.elements.title.value.trim();
        if (!memberIds.length) { showNotice("Choose at least one colleague."); return; }
        if (memberIds.length > 1 && title.length < 2) { showNotice("Add a name for your group chat."); return; }
        const button = form.querySelector("button[type=submit]");
        button.disabled = true;
        try {
            const result = await request("/api/staff/chat/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ member_ids: memberIds, title }) });
            await loadConversations();
            await selectConversation(result.id);
        } catch (error) { showNotice(error.message); }
        finally { button.disabled = false; }
    }

    async function loadIdentity() {
        try {
            const user = await request("/api/me");
            window.CataclysmCurrentUser = user;
            renderSettingsButton();
            if (user.role === "owner" || user.role === "admin") renderStaffHeader();
            loadNotifications();
        } catch { /* Keep staff controls hidden for signed-out visitors. */ }
    }

    loadIdentity();
    // Inline account scripts can replace the header contents after they finish loading.
    const observer = new MutationObserver(() => {
        if (window.CataclysmCurrentUser) {
            renderSettingsButton();
            if (window.CataclysmCurrentUser.role === "owner" || window.CataclysmCurrentUser.role === "admin") renderStaffHeader();
        }
    });
    observer.observe(accountArea, { childList: true });
})();
