(() => {
    "use strict";

    const accountArea = document.querySelector("#headerAccount, #accountArea, .header-account");
    if (!accountArea) return;

    const escapeHTML = value => String(value ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

    const formatDate = value => {
        const date = new Date(String(value || "").replace(" ", "T"));
        return Number.isNaN(date.getTime()) ? "Recently" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    };

    async function loadNotifications() {
        try {
            const response = await fetch("/api/notifications", { credentials: "same-origin" });
            if (!response.ok) return;
            const data = await response.json();
            renderSettingsButton();
            renderNotifications(data.notifications || [], data.unread || 0);
        } catch (error) {
            console.error("NOTIFICATIONS UI ERROR:", error);
        }
    }

    function renderSettingsButton() {
        if (document.getElementById("headerSettingsButton")) {
            return;
        }

        const settings = document.createElement("a");
        settings.id = "headerSettingsButton";
        settings.className = "header-settings";
        settings.href = "settings.html";
        settings.setAttribute("aria-label", "Open settings");
        settings.title = "Settings";
        settings.textContent = "⚙";

        accountArea.prepend(settings);
    }

    function renderNotifications(items, unread) {
        document.getElementById("notificationCenter")?.remove();
        const center = document.createElement("div");
        center.id = "notificationCenter";
        center.className = "notification-center";
        center.innerHTML = `
            <button type="button" class="notification-trigger" aria-expanded="false">
                <span aria-hidden="true">●</span> Alerts ${unread ? `<b>${unread > 9 ? "9+" : unread}</b>` : ""}
            </button>
            <section class="notification-panel" hidden>
                <div class="notification-panel-heading"><strong>NEWSROOM ALERTS</strong>${unread ? '<button type="button" class="notification-read-button">Mark all read</button>' : ""}</div>
                <div class="notification-list">
                    ${items.length ? items.map(item => `<a class="notification-item ${item.is_read ? "" : "unread"}" href="${escapeHTML(item.link || "#")}">${typeof item.image_url === "string" && item.image_url.startsWith("https://") ? `<img class="notification-image" src="${escapeHTML(item.image_url)}" alt="" loading="lazy">` : ""}<span class="notification-type">${escapeHTML(item.type || "update")}</span><strong>${escapeHTML(item.title)}</strong><p>${escapeHTML(item.message)}</p><small>${escapeHTML(formatDate(item.created_at))}</small></a>`).join("") : '<div class="notification-empty">No alerts yet. The newsroom is quiet.</div>'}
                </div>
            </section>`;
        accountArea.prepend(center);
        const trigger = center.querySelector(".notification-trigger");
        const panel = center.querySelector(".notification-panel");
        trigger.addEventListener("click", async () => {
            const opening = panel.hidden;
            panel.hidden = !opening;
            trigger.setAttribute("aria-expanded", String(opening));
            if (opening && unread) {
                try {
                    await fetch("/api/notifications/read", { method: "POST", credentials: "same-origin" });
                    trigger.querySelector("b")?.remove();
                    center.querySelectorAll(".notification-item.unread").forEach(item => item.classList.remove("unread"));
                    center.querySelector(".notification-read-button")?.remove();
                } catch (error) { console.error("MARK READ ERROR:", error); }
            }
        });
        document.addEventListener("click", event => {
            if (!center.contains(event.target) && !panel.hidden) {
                panel.hidden = true;
                trigger.setAttribute("aria-expanded", "false");
            }
        });
    }

    loadNotifications();
})();
